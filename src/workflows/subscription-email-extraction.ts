import type { GmailSourceAdapter } from "../adapters/gmail";
import type { ContextCandidate } from "../context/builder";
import { assertSourceSubjectContextCurrent } from "../context/source-subjects";
import { persistableContextManifest } from "../context/manifests";
import type { OperationalStore } from "../db/store";
import {
  EMAIL_EXTRACTION_PROMPT_VERSION,
  EMAIL_EXTRACTION_SCHEMA_VERSION,
} from "../gmail/extraction-contract";
import { GmailStore } from "../gmail/store";
import { semanticFindingsForExtraction } from "../findings/projector";
import { deriveFindingSemantics } from "../findings/semantics";
import {
  semanticFindingKinds, semanticFindingOwners,
  type ExtractionFindingRelation, type PriorFindingRelationCandidate,
} from "../findings/contract";
import { FindingStore } from "../findings/store";
import { newId } from "../util/ids";
import { extractionClassifications as classifications, extractionItemKinds as itemKinds, extractionOwners, gmailPromptSpec } from "../orchestration/prompt-contracts";
import { renderInstructions, type CompiledPolicyPrompt, type EvidenceDescriptor } from "../orchestration/prompt-spec";
import { failPreparedCallAndMarkWorkStale, prepareReasoningCall, requirePreparedReasoningCall } from "../orchestration/prepared-reasoning";
import { previewGmailExtractionContext } from "./gmail-extraction-preview";
import { WorkRepository } from "../work/repository";
import {
  refreshAfterExtraction, type PostExtractionRefresher, type PostExtractionRefreshReceipt,
} from "./post-extraction-refresh";

export interface EmailExtractionItem {
  kind: typeof itemKinds[number];
  statement: string;
  evidenceIds: string[];
  confidence: number;
  owner: typeof extractionOwners[number];
  dueDate: string | null;
  ambiguities: string[];
}

export interface EmailExtractionOutput {
  classification: typeof classifications[number];
  summary: string;
  items: EmailExtractionItem[];
  relations: ExtractionFindingRelation[];
  unresolved: string[];
  promptInjectionDetected: boolean;
}

export async function prepareSubscriptionEmailExtraction(input: {
  adapter: GmailSourceAdapter; store: OperationalStore; accountId: string;
  model: string; policyVersion: string; policyPrompt?: CompiledPolicyPrompt;
}): Promise<Record<string, unknown>> {
  input.store.migrate();
  const gmailStore = new GmailStore(input.store);
  gmailStore.invalidateExtractionVersion({
    accountId: input.accountId,
    promptVersion: EMAIL_EXTRACTION_PROMPT_VERSION,
    schemaVersion: EMAIL_EXTRACTION_SCHEMA_VERSION,
    policyVersion: input.policyVersion,
  });
  const workRepository = new WorkRepository(input.store);
  const leaseOwner = `prepare_${newId("work")}`;
  const work = workRepository.claimNext({
    workflow: "gmail_extraction", subjectSourceId: input.accountId,
    leaseOwner, leaseDurationMs: 30 * 60 * 1000,
  });
  if (!work) return { cached: false, empty: true, message: "No queued selected Gmail messages." };
  let preview;
  try {
    preview = await previewGmailExtractionContext({ ...input, workItem: work });
  } catch (error) {
    if (/changed|re-ingest/i.test(error instanceof Error ? error.message : String(error))) {
      workRepository.markStale({ workId: work.workId });
    } else {
      workRepository.fail({
        workId: work.workId, leaseOwner, category: "provider_transient", retryable: true,
        retryDelayMs: 30_000,
      });
    }
    throw error;
  }
  if (!preview) throw new Error("claimed Gmail work could not be prepared");
  const cached = gmailStore.findExtraction({
    accountId: input.accountId, messageId: preview.messageId, sourceHash: preview.sourceHash,
    promptVersion: EMAIL_EXTRACTION_PROMPT_VERSION,
    schemaVersion: EMAIL_EXTRACTION_SCHEMA_VERSION, policyVersion: input.policyVersion,
  });
  if (cached) {
    workRepository.complete({
      workId: work.workId, leaseOwner, sourceHash: work.sourceHash, containerHash: work.containerHash,
    });
    return {
      cached: true, extractionId: cached.extractionId, output: cached.output,
      projectionRefresh: refreshAfterExtraction({ store: input.store }),
    };
  }

  const call = prepareReasoningCall({
    store: input.store,
    identity: {
      workflow: "gmail_extraction", taskType: "subscription_email_extraction",
      model: input.model, promptVersion: EMAIL_EXTRACTION_PROMPT_VERSION,
      sourceHash: preview.sourceHash,
    },
    manifest: preview.manifest,
    auditManifest: persistableContextManifest(preview.manifest, gmailAuditItems),
  });
  return {
    cached: false, callId: call.callId, messageId: preview.messageId, threadStateHash: preview.threadStateHash,
    promptVersion: gmailPromptSpec.version, promptSpecHash: gmailPromptSpec.specHash,
    instructions: renderInstructions(gmailPromptSpec, input.policyPrompt), schema: gmailPromptSpec.schema,
    context: preview.manifest.includedItems.map((item) => item.content),
    evidence: gmailEvidence(preview.manifest.includedItems),
    allowedEvidenceIds: gmailEvidence(preview.manifest.includedItems).map((item) => item.id),
  };
}

export function gmailAuditItems(items: ContextCandidate[]): unknown[] {
  return items.map((item) => stripSourceText(item));
}

function stripSourceText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSourceText);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    if (["untrusted_authored_text", "authored_excerpt", "subject", "from", "to", "cc", "statement"].includes(key)) return [];
    return [[key, stripSourceText(item)]];
  }));
}

export async function submitSubscriptionEmailExtraction(input: {
  store: OperationalStore; accountId: string;
  callId: string; threadStateHash: string; policyVersion: string; output: EmailExtractionOutput;
  inputTokens?: number; outputTokens?: number; cachedTokens?: number;
  projectionRefresher?: PostExtractionRefresher;
}): Promise<{
  extractionId: string;
  output: EmailExtractionOutput;
  projectionRefresh: PostExtractionRefreshReceipt;
}> {
  const { call, manifest } = requirePreparedReasoningCall({
    store: input.store, callId: input.callId,
    workflow: "gmail_extraction", taskType: "subscription_email_extraction",
    notFoundMessage: "prepared subscription email extraction call not found",
  });
  const preparedSource = preparedSourceIdentity(manifest.includedItems);
  const preparedPolicyVersion = findStringField(manifest.includedItems, "policy_version");
  const workId = findStringField(manifest.includedItems, "work_id");
  const leaseOwner = findStringField(manifest.includedItems, "work_lease_owner");
  const workSourceHash = findStringField(manifest.includedItems, "work_source_hash");
  const workContainerHash = findStringField(manifest.includedItems, "work_container_hash");
  if (preparedPolicyVersion !== input.policyVersion) {
    throw new Error("prepared Gmail policy version mismatch; prepare extraction again");
  }
  const gmailStore = new GmailStore(input.store);
  if (!workId || !leaseOwner || !workSourceHash || !workContainerHash) {
    throw new Error("prepared Gmail work identity is missing");
  }
  const workRepository = new WorkRepository(input.store);
  if (!preparedSource || preparedSource.sourceHash !== call.sourceHash
    || preparedSource.threadStateHash !== input.threadStateHash
    || gmailStore.currentMessageHash(input.accountId, preparedSource.messageId) !== call.sourceHash
    || gmailStore.currentThreadHash(input.accountId, preparedSource.threadId) !== input.threadStateHash) {
    failPreparedCallAndMarkWorkStale({
      store: input.store, call, workId, category: "stale_source",
    });
    throw new Error("ingested Gmail source or thread changed; prepare extraction again");
  }
  workRepository.requireLease({
    workId, leaseOwner, sourceHash: workSourceHash, containerHash: workContainerHash,
  });
  try {
    assertSourceSubjectContextCurrent(input.store, manifest.includedItems);
    assertPriorFindingsCurrent(input.store, priorFindingCandidates(manifest.includedItems));
  } catch (error) {
    failPreparedCallAndMarkWorkStale({ store: input.store, call, workId, category: "context_changed" });
    throw error;
  }
  validateOutput(input.output, manifest.includedItems, call.sourceHash);

  const completedAt = new Date().toISOString();
  const extractionId = newId("extract");
  const extraction = {
    sourceType: "gmail_extraction" as const, extractionId, callId: input.callId,
    output: input.output as unknown as Record<string, unknown>, createdAt: completedAt,
  };
  const findings = semanticFindingsForExtraction(extraction);
  const semantics = deriveFindingSemantics({
    findings, evidenceDirections: gmailEvidenceDirections(manifest.includedItems),
    relations: input.output.relations, priorFindings: priorFindingCandidates(manifest.includedItems),
    relationValidatorVersion: EMAIL_EXTRACTION_PROMPT_VERSION,
  });
  gmailStore.saveExtraction({
    extractionId, accountId: input.accountId, messageId: preparedSource.messageId,
    sourceHash: preparedSource.sourceHash, threadStateHash: preparedSource.threadStateHash,
    callId: input.callId, classification: input.output.classification,
    output: input.output as unknown as Record<string, unknown>,
    promptVersion: EMAIL_EXTRACTION_PROMPT_VERSION,
    schemaVersion: EMAIL_EXTRACTION_SCHEMA_VERSION, policyVersion: input.policyVersion,
    model: call.model, createdAt: completedAt, call,
    usage: {
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.cachedTokens !== undefined ? { cachedTokens: input.cachedTokens } : {}),
    }, findings, communicationContexts: semantics.communicationContexts,
    relations: semantics.relations, workId, leaseOwner,
  });
  return {
    extractionId, output: input.output,
    projectionRefresh: (input.projectionRefresher ?? refreshAfterExtraction)({ store: input.store }),
  };
}

function findStringField(value: unknown, key: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringField(item, key);
      if (found !== undefined) return found;
    }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record[key] === "string") return record[key];
    for (const item of Object.values(record)) {
      const found = findStringField(item, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function preparedSourceIdentity(value: unknown): {
  messageId: string; threadId: string; sourceHash: string; threadStateHash: string;
} | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = preparedSourceIdentity(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message_id === "string" && typeof record.thread_id === "string"
      && typeof record.evidence_id === "string" && typeof record.thread_state_hash === "string") {
      const prefix = `gmail:${record.message_id}:`;
      if (record.evidence_id.startsWith(prefix)) return {
        messageId: record.message_id, threadId: record.thread_id,
        sourceHash: record.evidence_id.slice(prefix.length), threadStateHash: record.thread_state_hash,
      };
    }
    for (const item of Object.values(record)) {
      const found = preparedSourceIdentity(item);
      if (found) return found;
    }
  }
  return undefined;
}

function validateOutput(output: EmailExtractionOutput, manifestItems: unknown[], sourceHash?: string): void {
  if (!output || !classifications.includes(output.classification) || typeof output.summary !== "string"
    || !output.summary.trim() || !Array.isArray(output.items) || output.items.length > 20
    || !Array.isArray(output.relations) || output.relations.length > 20
    || !Array.isArray(output.unresolved) || typeof output.promptInjectionDetected !== "boolean") {
    throw new Error("email extraction output does not match the required schema");
  }
  if (["ignore", "reference_only"].includes(output.classification)
    && (output.items.length > 0 || output.relations.length > 0)) {
    throw new Error("email reference-only extraction cannot create durable findings");
  }
  enforceInjectionConsistency(output, manifestItems);
  const allowed = new Set(gmailEvidence(manifestItems).map((item) => item.id));
  const selectedEvidence = sourceHash ? [...allowed].find((id) => id.endsWith(`:${sourceHash}`)) : undefined;
  for (const item of output.items) {
    if (!item || typeof item !== "object" || !itemKinds.includes(item.kind)
      || typeof item.statement !== "string" || !item.statement.trim()
      || typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1
      || !extractionOwners.includes(item.owner) || !Array.isArray(item.evidenceIds)
      || item.evidenceIds.length === 0 || item.evidenceIds.some((id) => !allowed.has(id))
      || !(item.dueDate === null || typeof item.dueDate === "string")
      || !Array.isArray(item.ambiguities) || item.ambiguities.some((value) => typeof value !== "string")) {
      throw new Error("email extraction item contains invalid or unrecognized evidence");
    }
    if (selectedEvidence && !item.evidenceIds.includes(selectedEvidence)) {
      throw new Error("email extraction item must cite the selected message");
    }
  }
  validateRelations(output.relations, output.items, allowed, priorFindingCandidates(manifestItems));
}

function validateRelations(
  relations: ExtractionFindingRelation[], items: EmailExtractionItem[], allowed: Set<string>,
  prior: PriorFindingRelationCandidate[],
): void {
  const priorIds = new Set(prior.map((finding) => finding.findingId));
  for (const relation of relations) {
    const item = items[relation.fromItemIndex];
    if (!relation || !["responds_to", "resolves", "supersedes"].includes(relation.kind)
      || !Number.isInteger(relation.fromItemIndex) || !item
      || !priorIds.has(relation.toFindingId)
      || typeof relation.confidence !== "number" || relation.confidence < 0.75 || relation.confidence > 1
      || !Array.isArray(relation.evidenceIds) || relation.evidenceIds.length === 0
      || relation.evidenceIds.some((id) => !allowed.has(id) || !item.evidenceIds.includes(id))) {
      throw new Error("email extraction relation is invalid or ungrounded");
    }
  }
}

function gmailEvidenceDirections(value: unknown): Map<string, "incoming" | "outgoing" | "unknown"> {
  const result = new Map<string, "incoming" | "outgoing" | "unknown">();
  visitRecords(value, (record) => {
    if (typeof record.evidence_id !== "string" || !record.evidence_id.startsWith("gmail:")) return;
    const direction = record.message_type === "received" ? "incoming"
      : record.message_type === "sent" ? "outgoing" : "unknown";
    const existing = result.get(record.evidence_id);
    result.set(record.evidence_id, existing && existing !== direction ? "unknown" : direction);
  });
  return result;
}

function priorFindingCandidates(value: unknown): PriorFindingRelationCandidate[] {
  const result = new Map<string, PriorFindingRelationCandidate>();
  visitRecords(value, (record) => {
    if (typeof record.finding_id !== "string" || !/^finding_[A-Za-z0-9_-]+$/.test(record.finding_id)
      || !semanticFindingKinds.includes(record.kind as never)
      || !semanticFindingOwners.includes(record.owner as never)
      || !(record.due_date === null || typeof record.due_date === "string")
      || typeof record.finding_content_hash !== "string") return;
    result.set(record.finding_id, {
      findingId: record.finding_id, kind: record.kind as PriorFindingRelationCandidate["kind"],
      statement: typeof record.statement === "string" ? record.statement : "",
      owner: record.owner as PriorFindingRelationCandidate["owner"],
      dueDate: record.due_date as string | null, contentHash: record.finding_content_hash,
    });
  });
  return [...result.values()].sort((left, right) => left.findingId.localeCompare(right.findingId));
}

function assertPriorFindingsCurrent(
  store: OperationalStore, candidates: PriorFindingRelationCandidate[],
): void {
  const findings = new FindingStore(store);
  for (const candidate of candidates) {
    const current = findings.get(candidate.findingId);
    if (!current || current.status !== "active" || current.contentHash !== candidate.contentHash) {
      throw new Error("prepared Gmail finding context changed; prepare extraction again");
    }
  }
}

function gmailEvidence(value: unknown): EvidenceDescriptor[] {
  const records: EvidenceDescriptor[] = [];
  visitRecords(value, (record) => {
    const id = record.evidence_id;
    if (typeof id === "string" && /^gmail:[^:]+:sha256:/.test(id)) {
      records.push({ id, type: "provider_message", scope: "selected" });
    }
  });
  return [...new Map(records.map((item) => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

function enforceInjectionConsistency(output: EmailExtractionOutput, value: unknown): void {
  const indicators: string[] = [];
  const selectedMessageIndicators: string[] = [];
  visitRecords(value, (record) => {
    if (Array.isArray(record.prompt_injection_indicators)) indicators.push(...record.prompt_injection_indicators.map(String));
    if (Array.isArray(record.selected_message_prompt_injection_indicators)) {
      selectedMessageIndicators.push(...record.selected_message_prompt_injection_indicators.map(String));
    }
  });
  if (output.promptInjectionDetected !== (indicators.length > 0)
    || output.classification === "malicious_or_untrusted_instruction" && selectedMessageIndicators.length === 0) {
    throw new Error("email extraction contradicts deterministic prompt-injection indicators");
  }
}

function visitRecords(value: unknown, visitor: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) for (const item of value) visitRecords(item, visitor);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    visitor(record);
    for (const item of Object.values(record)) visitRecords(item, visitor);
  }
}
