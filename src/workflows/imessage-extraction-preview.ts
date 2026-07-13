import type { IMessageConversationSelection, IMessageSourceAdapter } from "../adapters/imessage";
import { buildContext, type ContextCandidate, type ContextManifest } from "../context/builder";
import { imessageDevelopmentContextCandidates } from "../context/imessage-development";
import { persistableContextManifest, type PersistableContextManifest } from "../context/manifests";
import type { ContextRequest } from "../context/request";
import type { OperationalStore } from "../db/store";
import { normalizeIMessage } from "../imessage/normalizer";
import { IMessageStore } from "../imessage/store";
import { FindingStore } from "../findings/store";
import { redactSensitiveTexts } from "../privacy/presidio";
import { imessagePromptSpec } from "../orchestration/prompt-contracts";
import { promptContext, type CompiledPolicyPrompt } from "../orchestration/prompt-spec";
import type { WorkItem } from "../work/contract";
import { WorkRepository } from "../work/repository";
import { sourceSubjectContextCandidate } from "../context/source-subjects";

export interface IMessageExtractionPreview {
  workId: string;
  messageId: string;
  conversationId: string;
  sourceHash: string;
  conversationStateHash: string;
  deltaEvidenceIds: string[];
  request: ContextRequest;
  manifest: ContextManifest;
  auditManifest: PersistableContextManifest;
  promptInjectionIndicators: string[];
  modelCalls: 0;
  retainedText: false;
}

export async function previewIMessageExtractionContext(input: {
  adapter: IMessageSourceAdapter; store: OperationalStore; sourceId: string;
  selection: IMessageConversationSelection; policyVersion?: string;
  policyPrompt?: CompiledPolicyPrompt;
  workItem?: WorkItem;
}): Promise<IMessageExtractionPreview | undefined> {
  input.store.migrate();
  const imessageStore = new IMessageStore(input.store);
  const work = input.workItem ?? new WorkRepository(input.store).peekNext({
    workflow: "imessage_extraction", subjectSourceId: input.sourceId,
  });
  if (!work) return undefined;
  if (work.workflow !== "imessage_extraction" || work.subjectSourceId !== input.sourceId) {
    throw new Error("Messages work subject does not match the configured source");
  }
  const identity = imessageStore.sourceIdentity(input.sourceId, work.anchorId);
  if (!identity || identity.conversationId !== work.subjectId
    || identity.contentHash !== work.sourceHash
    || imessageStore.conversationStateHash(input.sourceId, identity.conversationId) !== work.containerHash) {
    throw new Error("Messages work source or conversation changed; ingest again before extraction preview");
  }
  const candidate = {
    ...identity, conversationStateHash: work.containerHash,
    previousSentAt: imessageStore.previousProcessedSentAt(input.sourceId, identity.conversationId),
  };
  const sourceWindow = await input.adapter.getConversationWindow({
    sourceRowId: candidate.sourceRowId, selection: input.selection, limit: 12,
  });
  const normalizedWindow = sourceWindow.map(normalizeIMessage);
  const selected = normalizedWindow.find((message) => message.messageId === candidate.messageId);
  if (!selected || selected.contentHash !== candidate.contentHash
    || selected.conversationId !== candidate.conversationId
    || selected.participantSetHash !== candidate.participantSetHash) {
    throw new Error("Messages source or conversation changed; ingest again before extraction preview");
  }
  const conversationStateHash = imessageStore.conversationStateHash(input.sourceId, candidate.conversationId);
  if (!conversationStateHash || conversationStateHash !== candidate.conversationStateHash) {
    throw new Error("ingested Messages conversation state changed; prepare again");
  }
  const redactions = await redactSensitiveTexts(normalizedWindow.map((message) => message.normalizedText));
  const turns = normalizedWindow.map((message, index) => ({
    evidence_id: evidenceId(message.messageId, message.contentHash),
    is_new_or_changed: candidate.previousSentAt === null || message.sentAt > candidate.previousSentAt
      || message.messageId === selected.messageId && message.contentHash !== candidate.contentHash,
    sent_at: message.sentAt,
    direction: message.direction,
    service: message.service,
    untrusted_text: boundedText(redactions[index]!.text, 2000),
    truncated: redactions[index]!.text.length > 2000,
    sensitive_entities_redacted: redactions[index]!.findings.map((finding) => finding.entityType),
  }));
  const selectedIndex = normalizedWindow.indexOf(selected);
  const selectedRedaction = redactions[selectedIndex]!;
  const selectedEvidenceId = evidenceId(selected.messageId, selected.contentHash);
  const deltaEvidenceIds = turns.filter((turn) => turn.is_new_or_changed)
    .map((turn) => turn.evidence_id);
  if (deltaEvidenceIds.length === 0) deltaEvidenceIds.push(selectedEvidenceId);
  const promptInjectionIndicators = detectPromptInjection([
    boundedText(selectedRedaction.text, 8000),
    ...redactions.map((redaction) => boundedText(redaction.text, 2000)),
  ].join("\n"));
  const priorFindings = new FindingStore(input.store).activeRelationCandidatesForContainer({
    sourceType: "imessage_extraction", sourceId: input.sourceId,
    containerId: selected.conversationId,
  });
  const candidates: ContextCandidate[] = [
    workContextCandidate(work),
    {
      id: `imessage-metadata:${selected.messageId}`, category: "source", retrievalLevel: 0,
      content: {
        evidence_id: selectedEvidenceId, message_id: selected.messageId,
        conversation_id: selected.conversationId,
        conversation_state_hash: conversationStateHash,
        sent_at: selected.sentAt, direction: selected.direction, service: selected.service,
        delta_evidence_ids: deltaEvidenceIds,
        prompt_injection_indicators: promptInjectionIndicators,
      },
      tokenEstimate: 140, relevance: 1, impact: 1, recency: 1,
      sourceRefs: [selectedEvidenceId, selected.contentHash],
    },
    {
      id: `imessage-selected:${selected.messageId}`, category: "source", retrievalLevel: 2,
      content: {
        evidence_id: selectedEvidenceId,
        untrusted_message_text: boundedText(selectedRedaction.text, 8000),
        truncated: selectedRedaction.text.length > 8000,
        sensitive_entities_redacted: selectedRedaction.findings.map((finding) => finding.entityType),
      },
      tokenEstimate: Math.ceil(Math.min(selectedRedaction.text.length, 8000) / 4) + 40,
      relevance: 1, impact: 1, recency: 1,
      sourceRefs: [selectedEvidenceId, selected.textHash],
    },
    {
      id: `imessage-conversation:${selected.conversationId}`,
      category: "recent_change", retrievalLevel: 2,
      content: { conversation_id: selected.conversationId, recent_turns: turns },
      tokenEstimate: Math.ceil(JSON.stringify(turns).length / 4),
      relevance: 0.9, impact: 0.8, recency: 1,
      sourceRefs: turns.map((turn) => turn.evidence_id),
    },
    ...(work.streamEventId ? [sourceSubjectContextCandidate({
      store: input.store, eventId: work.streamEventId,
    })] : []),
    ...imessageDevelopmentContextCandidates({
      store: input.store,
      sourceId: input.sourceId,
      conversationId: selected.conversationId,
    }),
    ...(priorFindings.length > 0 ? [{
      id: `findings:${selected.conversationId}`, category: "entity_state" as const, retrievalLevel: 1 as const,
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
  const budget = {
    maxInputTokens: 12000, reservedOutputTokens: 1200,
    sourceTokens: 2200, entityStateTokens: 2200, recentChangeTokens: 6200,
    policyTokens: 500, contingencyTokens: 900,
  };
  const request: ContextRequest = {
    workflow: "imessage_extraction",
    trigger: {
      type: "source_delta",
      subjectId: selected.conversationId,
      sourceIdentities: [{
        provider: "imessage",
        sourceId: input.sourceId,
        artifactId: selected.messageId,
        versionHash: selected.contentHash,
        containerId: selected.conversationId,
        containerHash: conversationStateHash,
      }],
    },
    purpose: "extract",
    budget,
  };
  const manifest = buildContext(candidates, budget);
  return {
    workId: work.workId,
    messageId: selected.messageId, conversationId: selected.conversationId,
    sourceHash: selected.contentHash, conversationStateHash, deltaEvidenceIds,
    request, manifest, auditManifest: persistableContextManifest(manifest, imessageAuditItems),
    promptInjectionIndicators, modelCalls: 0, retainedText: false,
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
    ? promptContext(imessagePromptSpec, policy)
    : { prompt_contract: { workflow: imessagePromptSpec.workflow, spec_hash: imessagePromptSpec.specHash, rules: imessagePromptSpec.rules }, policy_version: policyVersion ?? "unvalidated-preview" };
  return {
    id: `policy:${imessagePromptSpec.version}`, category: "policy", retrievalLevel: 0,
    content, tokenEstimate: Math.ceil(JSON.stringify(content).length / 4),
    relevance: 1, impact: 1, sourceRefs: [imessagePromptSpec.specHash, ...(policyVersion ? [policyVersion] : [])],
  };
}

export function imessageAuditItems(items: ContextCandidate[]): unknown[] {
  return items.map(stripTransientText);
}

function stripTransientText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTransientText);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    if ([
      "untrusted_message_text", "untrusted_text", "display_name", "aliases",
      "recent_interaction_summary", "description", "summary", "location", "statement",
    ].includes(key)) return [];
    return [[key, stripTransientText(item)]];
  }));
}

function evidenceId(messageId: string, sourceHash: string): string {
  return `imessage:${messageId}:${sourceHash}`;
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
