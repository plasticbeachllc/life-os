import type { GmailSourceAdapter } from "../adapters/gmail";
import { buildContext, type ContextCandidate } from "../context/builder";
import { persistableContextManifest } from "../context/manifests";
import type { OperationalStore } from "../db/store";
import { gmailParticipantLabels } from "../gmail/identity";
import { normalizeGmailMessage } from "../gmail/normalizer";
import { GmailStore, gmailThreadStateHash } from "../gmail/store";
import { gmailReplyDraftPromptSpec } from "../orchestration/prompt-contracts";
import {
  completeReasoningCall, failReasoningCall, prepareReasoningCall, requirePreparedReasoningCall,
} from "../orchestration/prepared-reasoning";
import {
  instructionTokenEstimate, promptContext, renderInstructions,
  type CompiledPolicyPrompt,
} from "../orchestration/prompt-spec";
import { redactSensitiveTexts } from "../privacy/presidio";

export const GMAIL_REPLY_DRAFT_SCHEMA_VERSION = "gmail-reply-draft-schema-v1";

export interface GmailReplyDraftOutput {
  status: "ready" | "needs_clarification";
  body: string | null;
  clarification: string | null;
  evidenceIds: string[];
  assumptions: string[];
}

export interface PreparedGmailReplyDraft {
  callId: string;
  threadStateHash: string;
  promptVersion: string;
  promptSpecHash: string;
  instructions: string;
  schema: Record<string, unknown>;
  context: unknown[];
  allowedEvidenceIds: string[];
}

export async function prepareGmailReplyDraft(input: {
  adapter: GmailSourceAdapter; store: OperationalStore; accountId: string; threadId: string;
  expectedThreadStateHash: string; findingStatements: string[]; participantLabels: string[];
  draftKind: "reply" | "follow_up"; model: string; policyVersion: string;
  policyPrompt?: CompiledPolicyPrompt;
}): Promise<PreparedGmailReplyDraft> {
  input.store.migrate();
  if (!input.findingStatements.length || input.findingStatements.length > 10
    || input.findingStatements.some((statement) => !statement.trim() || statement.length > 500)) {
    throw new Error("Gmail draft requires bounded finding context");
  }
  const gmail = new GmailStore(input.store);
  if (gmail.currentThreadHash(input.accountId, input.threadId) !== input.expectedThreadStateHash) {
    throw new Error("Gmail draft source changed; refresh before drafting");
  }
  const thread = await input.adapter.getThread(input.threadId);
  const normalized = (thread.messages ?? []).map(normalizeGmailMessage);
  const liveThreadStateHash = gmailThreadStateHash(normalized);
  if (liveThreadStateHash !== input.expectedThreadStateHash) {
    throw new Error("Gmail thread changed; sync before drafting");
  }
  const selected = [...normalized]
    .sort((left, right) => Number(left.internalDate) - Number(right.internalDate)
      || left.messageId.localeCompare(right.messageId))
    .slice(-8);
  if (selected.length === 0) throw new Error("Gmail draft thread is empty");
  const redactions = await redactSensitiveTexts(selected.map((message) => message.authoredBody));
  const turns = selected.map((message, index) => ({
    evidence_id: evidenceId(message.messageId, message.contentHash),
    direction: message.labelIds.includes("SENT") ? "outgoing" : "incoming",
    sender_label: gmailParticipantLabels([message.fromAddress])[0] ?? null,
    authored_text: bounded(redactions[index]!.text, 900),
    sensitive_entities_redacted: redactions[index]!.findings.map((finding) => finding.entityType),
    occurred_at: new Date(Number(message.internalDate)).toISOString(),
  }));
  const sourceIdentity = {
    account_id: input.accountId, thread_id: input.threadId,
    thread_state_hash: liveThreadStateHash, policy_version: input.policyVersion,
  };
  const candidates: ContextCandidate[] = [
    {
      id: `gmail-draft-source:${input.threadId}`, category: "source", retrievalLevel: 0,
      content: sourceIdentity, tokenEstimate: 80, relevance: 1, impact: 1, recency: 1,
      sourceRefs: [input.threadId, liveThreadStateHash],
    },
    {
      id: `gmail-draft-goal:${input.threadId}`, category: "entity_state", retrievalLevel: 1,
      content: {
        draft_kind: input.draftKind,
        participant_labels: safeLabels(input.participantLabels),
        active_findings: input.findingStatements,
      },
      tokenEstimate: Math.ceil(JSON.stringify(input.findingStatements).length / 4) + 80,
      relevance: 1, impact: 1, recency: 1,
      sourceRefs: [liveThreadStateHash],
    },
    {
      id: `gmail-draft-thread:${input.threadId}`, category: "source", retrievalLevel: 3,
      content: { recent_turns: turns },
      tokenEstimate: Math.ceil(JSON.stringify(turns).length / 4), relevance: 1, impact: 1, recency: 1,
      sourceRefs: turns.map((turn) => turn.evidence_id),
    },
    policyCandidate(input.policyPrompt, input.policyVersion),
  ];
  const manifest = buildContext(candidates, {
    maxInputTokens: 4400, reservedOutputTokens: 700,
    sourceTokens: 2800, entityStateTokens: 600, recentChangeTokens: 0,
    policyTokens: 700, contingencyTokens: 300,
  });
  const allowedEvidenceIds = collectEvidenceIds(manifest.includedItems);
  if (allowedEvidenceIds.length === 0) throw new Error("Gmail draft context omitted all source evidence");
  const call = prepareReasoningCall({
    store: input.store,
    identity: {
      workflow: "gmail_reply_draft", taskType: "subscription_gmail_reply_draft",
      model: input.model, promptVersion: gmailReplyDraftPromptSpec.version,
      sourceHash: liveThreadStateHash,
    },
    manifest,
    auditManifest: persistableContextManifest(manifest, gmailDraftAuditItems),
  });
  return {
    callId: call.callId, threadStateHash: liveThreadStateHash,
    promptVersion: gmailReplyDraftPromptSpec.version,
    promptSpecHash: gmailReplyDraftPromptSpec.specHash,
    instructions: renderInstructions(gmailReplyDraftPromptSpec, input.policyPrompt),
    schema: gmailReplyDraftPromptSpec.schema,
    context: manifest.includedItems.map((item) => item.content),
    allowedEvidenceIds,
  };
}

export async function submitGmailReplyDraft(input: {
  adapter: GmailSourceAdapter; store: OperationalStore; callId: string;
  accountId: string; threadId: string; expectedThreadStateHash: string;
  policyVersion: string; output: GmailReplyDraftOutput;
}): Promise<GmailReplyDraftOutput> {
  const { call, manifest } = requirePreparedReasoningCall({
    store: input.store, callId: input.callId,
    workflow: "gmail_reply_draft", taskType: "subscription_gmail_reply_draft",
    notFoundMessage: "prepared Gmail reply draft call not found",
  });
  const identity = draftSourceIdentity(manifest.includedItems);
  if (!identity || identity.accountId !== input.accountId || identity.threadId !== input.threadId
    || identity.threadStateHash !== input.expectedThreadStateHash
    || identity.policyVersion !== input.policyVersion || call.sourceHash !== identity.threadStateHash) {
    failReasoningCall({ store: input.store, call, category: "context_changed" });
    throw new Error("prepared Gmail draft context changed; prepare again");
  }
  const gmail = new GmailStore(input.store);
  const thread = await input.adapter.getThread(input.threadId);
  const liveHash = gmailThreadStateHash((thread.messages ?? []).map(normalizeGmailMessage));
  if (gmail.currentThreadHash(input.accountId, input.threadId) !== identity.threadStateHash
    || liveHash !== identity.threadStateHash) {
    failReasoningCall({ store: input.store, call, category: "stale_source" });
    throw new Error("Gmail thread changed while drafting; sync and prepare again");
  }
  try {
    validateGmailReplyDraft(input.output, allowedEvidence(manifest.includedItems));
  } catch (error) {
    failReasoningCall({ store: input.store, call, category: "invalid_output" });
    throw error;
  }
  completeReasoningCall({ store: input.store, call });
  return input.output;
}

export function validateGmailReplyDraft(output: GmailReplyDraftOutput, allowed: Set<string>): void {
  if (!output || Object.keys(output).sort().join(",") !== "assumptions,body,clarification,evidenceIds,status"
    || !["ready", "needs_clarification"].includes(output.status)
    || !Array.isArray(output.evidenceIds) || output.evidenceIds.length === 0 || output.evidenceIds.length > 8
    || new Set(output.evidenceIds).size !== output.evidenceIds.length
    || output.evidenceIds.some((id) => !allowed.has(id))
    || !Array.isArray(output.assumptions) || output.assumptions.length > 5
    || output.assumptions.some((item) => typeof item !== "string" || !item.trim() || item.length > 240)) {
    throw new Error("Gmail reply draft output does not match the required schema");
  }
  if (output.status === "ready") {
    if (typeof output.body !== "string" || !output.body.trim() || output.body.length > 2_000
      || output.clarification !== null || forbiddenDraftContent.test(output.body)) {
      throw new Error("Gmail reply draft body is invalid or unsafe");
    }
  } else if (output.body !== null || typeof output.clarification !== "string"
    || !output.clarification.trim() || output.clarification.length > 300
    || forbiddenDraftContent.test(output.clarification)) {
    throw new Error("Gmail reply draft clarification is invalid or unsafe");
  }
}

function policyCandidate(policy: CompiledPolicyPrompt | undefined, policyVersion: string): ContextCandidate {
  const content = policy ? promptContext(gmailReplyDraftPromptSpec, policy) : {
    prompt_contract: {
      workflow: gmailReplyDraftPromptSpec.workflow,
      spec_hash: gmailReplyDraftPromptSpec.specHash,
      rules: gmailReplyDraftPromptSpec.rules,
    },
    policy_version: policyVersion,
  };
  return {
    id: `policy:${gmailReplyDraftPromptSpec.version}`, category: "policy", retrievalLevel: 0,
    content, tokenEstimate: instructionTokenEstimate(gmailReplyDraftPromptSpec, policy),
    relevance: 1, impact: 1, sourceRefs: [gmailReplyDraftPromptSpec.specHash, policyVersion],
  };
}

function gmailDraftAuditItems(items: ContextCandidate[]): unknown[] {
  return items.map((item) => item.id.startsWith("gmail-draft-thread:")
    ? { ...item, content: { transient_thread_content_omitted: true,
      evidence_ids: collectEvidenceIds(item.content) } }
    : item);
}

function collectEvidenceIds(value: unknown): string[] {
  const ids: string[] = [];
  visit(value, (record) => {
    if (typeof record.evidence_id === "string") ids.push(record.evidence_id);
  });
  return [...new Set(ids)];
}

function allowedEvidence(items: unknown[]): Set<string> {
  const ids = new Set<string>();
  visit(items, (record) => {
    if (Array.isArray(record.evidence_ids)) {
      for (const id of record.evidence_ids) if (typeof id === "string") ids.add(id);
    }
  });
  return ids;
}

interface DraftSourceIdentity {
  accountId: string; threadId: string; threadStateHash: string; policyVersion: string;
}

function draftSourceIdentity(items: unknown[]): DraftSourceIdentity | undefined {
  let result: DraftSourceIdentity | undefined;
  visit(items, (record) => {
    if (result || typeof record.account_id !== "string" || typeof record.thread_id !== "string"
      || typeof record.thread_state_hash !== "string" || typeof record.policy_version !== "string") return;
    result = {
      accountId: record.account_id, threadId: record.thread_id,
      threadStateHash: record.thread_state_hash, policyVersion: record.policy_version,
    };
  });
  return result;
}

function visit(value: unknown, visitor: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) for (const item of value) visit(item, visitor);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    visitor(record);
    for (const item of Object.values(record)) visit(item, visitor);
  }
}

function evidenceId(messageId: string, sourceHash: string): string {
  return `gmail:${messageId}:${sourceHash}`;
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function safeLabels(values: string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value && value.length <= 100 && !value.includes("@")))].slice(0, 10);
}

const forbiddenDraftContent = /(?:sha256:|https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:message|thread|call|manifest)_[A-Za-z0-9_-]+\b|<[^>]+>)/i;
