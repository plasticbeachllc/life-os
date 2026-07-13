import type { GmailSourceAdapter } from "../adapters/gmail";
import { buildContext, type ContextCandidate, type ContextManifest } from "../context/builder";
import type { OperationalStore } from "../db/store";
import { normalizeGmailMessage } from "../gmail/normalizer";
import { GmailStore } from "../gmail/store";
import { gmailThreadStateHash } from "../gmail/store";
import { FindingStore } from "../findings/store";
import { redactSensitiveTexts } from "../privacy/presidio";
import { gmailPromptSpec } from "../orchestration/prompt-contracts";
import { promptContext, type CompiledPolicyPrompt } from "../orchestration/prompt-spec";
import type { WorkItem } from "../work/contract";
import { WorkRepository } from "../work/repository";

export interface GmailExtractionPreview {
  workId: string;
  messageId: string;
  threadId: string;
  sourceHash: string;
  threadStateHash: string;
  manifest: ContextManifest;
  promptInjectionIndicators: string[];
  selectedMessagePromptInjectionIndicators: string[];
  modelCalls: 0;
  retainedBody: false;
}

export async function previewGmailExtractionContext(input: {
  adapter: GmailSourceAdapter; store: OperationalStore; accountId: string;
  policyVersion?: string; policyPrompt?: CompiledPolicyPrompt;
  workItem?: WorkItem;
}): Promise<GmailExtractionPreview | undefined> {
  input.store.migrate();
  const gmailStore = new GmailStore(input.store);
  const work = input.workItem ?? new WorkRepository(input.store).peekNext({
    workflow: "gmail_extraction", subjectSourceId: input.accountId,
  });
  if (!work) return undefined;
  if (work.workflow !== "gmail_extraction" || work.subjectSourceId !== input.accountId) {
    throw new Error("Gmail work subject does not match the configured account");
  }
  const candidate = gmailStore.messageIdentity(input.accountId, work.anchorId);
  if (!candidate || candidate.messageId !== work.subjectId
    || candidate.contentHash !== work.sourceHash
    || gmailStore.currentThreadHash(input.accountId, candidate.threadId) !== work.containerHash) {
    throw new Error("Gmail work source changed; re-ingest before extraction preview");
  }
  const message = await input.adapter.getMessage(candidate.messageId);
  if (!(message.labelIds ?? []).includes("IMPORTANT")) throw new Error("extraction candidate no longer has IMPORTANT label");
  const normalized = normalizeGmailMessage(message);
  if (normalized.contentHash !== candidate.contentHash) throw new Error("Gmail source hash changed; re-ingest before extraction preview");
  const thread = await input.adapter.getThread(candidate.threadId);
  const normalizedThread = (thread.messages ?? []).map(normalizeGmailMessage);
  const recentThread = normalizedThread
    .sort((left, right) => Number(left.internalDate) - Number(right.internalDate))
    .slice(-5);
  const redactions = await redactSensitiveTexts([
    ...recentThread.map((turn) => turn.authoredBody), normalized.subject ?? "",
  ]);
  const redactedTurns = recentThread.map((turn, index) => ({ turn, redacted: redactions[index]! }));
  const redactedSubject = redactions.at(-1)!;
  const redactedSelected = redactedTurns.find(({ turn }) => turn.messageId === normalized.messageId)?.redacted
    ?? (await redactSensitiveTexts([normalized.authoredBody]))[0]!;
  const turns = redactedTurns.map(({ turn, redacted }) => ({
      message_id: turn.messageId,
      internal_date: turn.internalDate,
      message_type: gmailMessageType(turn),
      from: turn.fromAddress,
      authored_excerpt: boundedText(redacted.text, 1200),
      sensitive_entities_redacted: redacted.findings.map((finding) => finding.entityType),
      source_hash: turn.contentHash,
    }));
  const evidenceId = `gmail:${normalized.messageId}:${normalized.contentHash}`;
  const threadStateHash = gmailThreadStateHash(normalizedThread);
  if (threadStateHash !== work.containerHash) {
    throw new Error("Gmail work thread changed; re-ingest before extraction preview");
  }
  const selectedMessagePromptInjectionIndicators = detectPromptInjection([
    boundedText(redactedSubject.text, 1200),
    boundedText(redactedSelected.text, 6000),
  ].join("\n"));
  const promptInjectionIndicators = detectPromptInjection([
    boundedText(redactedSubject.text, 1200),
    boundedText(redactedSelected.text, 6000),
    ...redactedTurns.map(({ redacted }) => boundedText(redacted.text, 1200)),
  ].join("\n"));
  const entityCandidates = exactEntityCandidates(input.store, normalized);
  const priorFindings = new FindingStore(input.store).activeRelationCandidatesForContainer({
    sourceType: "gmail_extraction", sourceId: input.accountId, containerId: normalized.threadId,
  });
  const candidates: ContextCandidate[] = [
    workContextCandidate(work),
    {
      id: `gmail-metadata:${normalized.messageId}`, category: "source", retrievalLevel: 0,
      content: {
        evidence_id: evidenceId, message_id: normalized.messageId,
        thread_id: normalized.threadId, thread_state_hash: threadStateHash,
        internal_date: normalized.internalDate,
        message_type: gmailMessageType(normalized),
        from: normalized.fromAddress, to: normalized.toAddresses,
        cc: normalized.ccAddresses, subject: boundedText(redactedSubject.text, 1200),
        subject_sensitive_entities_redacted: redactedSubject.findings.map((finding) => finding.entityType),
        prompt_injection_indicators: promptInjectionIndicators,
        selected_message_prompt_injection_indicators: selectedMessagePromptInjectionIndicators,
      },
      tokenEstimate: 180, relevance: 1, impact: 1, recency: 1,
      sourceRefs: [evidenceId, normalized.contentHash],
    },
    {
      id: `gmail-authored:${normalized.messageId}`, category: "source", retrievalLevel: 2,
      content: {
        evidence_id: evidenceId,
        message_type: gmailMessageType(normalized),
        untrusted_authored_text: boundedText(redactedSelected.text, 6000),
        truncated: redactedSelected.text.length > 6000,
        sensitive_entities_redacted: redactedSelected.findings.map((finding) => finding.entityType),
      },
      tokenEstimate: Math.ceil(Math.min(redactedSelected.text.length, 6000) / 4) + 40,
      relevance: 1, impact: 1, recency: 1,
      sourceRefs: [evidenceId, normalized.authoredBodyHash],
    },
    {
      id: `gmail-thread:${normalized.threadId}`, category: "recent_change", retrievalLevel: 1,
      content: { thread_id: normalized.threadId, recent_turns: turns },
      tokenEstimate: Math.ceil(JSON.stringify(turns).length / 4),
      relevance: 0.85, impact: 0.8, recency: 1,
      sourceRefs: turns.flatMap((turn) => [`gmail:${turn.message_id}:${turn.source_hash}`, turn.source_hash]),
    },
    ...(entityCandidates.length > 0 ? [{
      id: `entities:${normalized.messageId}`, category: "entity_state" as const, retrievalLevel: 1 as const,
      content: { exact_candidates: entityCandidates },
      tokenEstimate: Math.ceil(JSON.stringify(entityCandidates).length / 4),
      relevance: 0.9, impact: 0.8, recency: 1,
      sourceRefs: entityCandidates.flatMap((candidate) => [candidate.entity_id, candidate.state_id]),
    }] : []),
    ...(priorFindings.length > 0 ? [{
      id: `findings:${normalized.threadId}`, category: "entity_state" as const, retrievalLevel: 1 as const,
      content: { prior_findings: priorFindings.map((finding) => ({
        finding_id: finding.findingId, kind: finding.kind, statement: finding.statement,
        owner: finding.owner, due_date: finding.dueDate,
        finding_content_hash: finding.contentHash,
      })) },
      tokenEstimate: Math.ceil(JSON.stringify(priorFindings).length / 4),
      relevance: 1, impact: 0.9, recency: 1,
      sourceRefs: priorFindings.flatMap((finding) => [finding.findingId, finding.contentHash]),
    }] : []),
    policyCandidate(input.policyPrompt, input.policyVersion),
  ];
  const manifest = buildContext(candidates, {
    maxInputTokens: 3900, reservedOutputTokens: 900,
    sourceTokens: 1750, entityStateTokens: 400, recentChangeTokens: 950,
    policyTokens: 450, contingencyTokens: 350,
  });
  return {
    workId: work.workId,
    messageId: normalized.messageId, threadId: normalized.threadId,
    sourceHash: normalized.contentHash, threadStateHash,
    manifest, promptInjectionIndicators, selectedMessagePromptInjectionIndicators,
    modelCalls: 0, retainedBody: false,
  };
}

function workContextCandidate(work: WorkItem): ContextCandidate {
  const content = {
    work_id: work.workId,
    ...(work.leaseOwner ? { work_lease_owner: work.leaseOwner } : {}),
    work_source_hash: work.sourceHash,
    work_container_hash: work.containerHash,
  };
  return {
    id: `work:${work.workId}`, category: "policy", retrievalLevel: 0,
    content, tokenEstimate: 80, relevance: 1, impact: 1,
    sourceRefs: [work.workId, work.invalidationKey],
  };
}

function policyCandidate(policy?: CompiledPolicyPrompt, policyVersion?: string): ContextCandidate {
  const content = policy
    ? promptContext(gmailPromptSpec, policy)
    : { prompt_contract: { workflow: gmailPromptSpec.workflow, spec_hash: gmailPromptSpec.specHash, rules: gmailPromptSpec.rules }, policy_version: policyVersion ?? "unvalidated-preview" };
  return {
    id: `policy:${gmailPromptSpec.version}`, category: "policy", retrievalLevel: 0,
    content, tokenEstimate: Math.ceil(JSON.stringify(content).length / 4),
    relevance: 1, impact: 1, sourceRefs: [gmailPromptSpec.specHash, ...(policyVersion ? [policyVersion] : [])],
  };
}

function gmailMessageType(message: ReturnType<typeof normalizeGmailMessage>): "draft" | "sent" | "received" {
  if (message.labelIds.includes("DRAFT")) return "draft";
  if (message.labelIds.includes("SENT")) return "sent";
  return "received";
}

function exactEntityCandidates(store: OperationalStore, message: ReturnType<typeof normalizeGmailMessage>): Array<{
  entity_id: string; state_id: string; entity_type: "person" | "project"; match_basis: string;
  display_name: string;
}> {
  const addressText = [message.fromAddress, ...message.toAddresses, ...message.ccAddresses]
    .filter(Boolean).join(" ").toLowerCase();
  const people = store.listCurrentDerivedStates("person_state").flatMap((state) => {
    const emails = Array.isArray(state.content.emails) ? state.content.emails.map(String) : [];
    const matched = emails.find((email) => addressText.includes(email.toLowerCase()));
    if (!matched || !state.entityId) return [];
    return [{
      entity_id: state.entityId, state_id: state.stateId, entity_type: "person" as const,
      match_basis: `exact_email:${matched.toLowerCase()}`,
      display_name: String(state.content.display_name ?? state.entityId),
    }];
  });
  const projects = store.listCurrentDerivedStates("project_state").flatMap((state) => {
    if (!state.entityId || !message.authoredBody.includes(state.entityId)) return [];
    return [{
      entity_id: state.entityId, state_id: state.stateId, entity_type: "project" as const,
      match_basis: "exact_canonical_id", display_name: String(state.content.name ?? state.entityId),
    }];
  });
  return [...people, ...projects].slice(0, 10);
}

function boundedText(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : value.slice(0, maxCharacters);
}

function detectPromptInjection(value: string): string[] {
  const indicators: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["instruction_override", /ignore (all |any )?(previous|prior|system) instructions/i],
    ["secret_exfiltration", /(reveal|show|print|send).{0,40}(secret|token|password|system prompt)/i],
    ["agent_impersonation", /(you are now|act as|system message|developer message)/i],
    ["path_or_shell_request", /(\.\.\/|\/etc\/|execute shell|run command|terminal command)/i],
  ];
  for (const [name, pattern] of checks) if (pattern.test(value)) indicators.push(name);
  return indicators;
}
