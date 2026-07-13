import type { IMessageConversationSelection, IMessageSourceAdapter } from "../adapters/imessage";
import type { OperationalStore } from "../db/store";
import { IMessageStore } from "../imessage/store";
import { semanticFindingsForExtraction } from "../findings/projector";
import { newId } from "../util/ids";
import { extractionClassifications as classifications, extractionItemKinds as itemKinds, extractionOwners, imessagePromptSpec } from "../orchestration/prompt-contracts";
import { renderInstructions, type CompiledPolicyPrompt, type EvidenceDescriptor } from "../orchestration/prompt-spec";
import { prepareReasoningCall, requirePreparedReasoningCall } from "../orchestration/prepared-reasoning";
import { previewIMessageExtractionContext } from "./imessage-extraction-preview";
import { refetchIMessage } from "./imessage-refetch";
import { WorkRepository } from "../work/repository";
import {
  refreshAfterExtraction, type PostExtractionRefresher, type PostExtractionRefreshReceipt,
} from "./post-extraction-refresh";

export const IMESSAGE_EXTRACTION_PROMPT_VERSION = imessagePromptSpec.version;
export const IMESSAGE_EXTRACTION_SCHEMA_VERSION = "imessage-extraction-schema-v3";

export interface IMessageExtractionItem {
  kind: typeof itemKinds[number];
  statement: string;
  evidenceIds: string[];
  confidence: number;
  owner: typeof extractionOwners[number];
  dueDate: string | null;
  ambiguities: string[];
}

export interface IMessageExtractionOutput {
  classification: typeof classifications[number];
  summary: string;
  items: IMessageExtractionItem[];
  unresolved: string[];
  promptInjectionDetected: boolean;
}

export async function prepareSubscriptionIMessageExtraction(input: {
  adapter: IMessageSourceAdapter; store: OperationalStore; sourceId: string;
  selection: IMessageConversationSelection; model: string; policyVersion: string;
  policyPrompt?: CompiledPolicyPrompt;
}): Promise<Record<string, unknown>> {
  const imessageStore = new IMessageStore(input.store);
  imessageStore.enqueueExtractionRefreshes({
    sourceId: input.sourceId, promptVersion: IMESSAGE_EXTRACTION_PROMPT_VERSION,
    schemaVersion: IMESSAGE_EXTRACTION_SCHEMA_VERSION, policyVersion: input.policyVersion,
    now: new Date().toISOString(),
  });
  const workRepository = new WorkRepository(input.store);
  const leaseOwner = `prepare_${newId("work")}`;
  const work = workRepository.claimNext({
    workflow: "imessage_extraction", subjectSourceId: input.sourceId,
    leaseOwner, leaseDurationMs: 30 * 60 * 1000,
  });
  if (!work) return { cached: false, empty: true, message: "No queued Messages sources." };
  let preview;
  try {
    preview = await previewIMessageExtractionContext({ ...input, workItem: work });
  } catch (error) {
    if (/changed|ingest again/i.test(error instanceof Error ? error.message : String(error))) {
      workRepository.markStale({ workId: work.workId });
    } else {
      workRepository.fail({
        workId: work.workId, leaseOwner, category: "provider_transient", retryable: true,
        retryDelayMs: 30_000,
      });
    }
    throw error;
  }
  if (!preview) throw new Error("claimed Messages work could not be prepared");
  const cached = imessageStore.findExtraction({
    sourceId: input.sourceId, messageId: preview.messageId, sourceHash: preview.sourceHash,
    promptVersion: IMESSAGE_EXTRACTION_PROMPT_VERSION,
    schemaVersion: IMESSAGE_EXTRACTION_SCHEMA_VERSION, policyVersion: input.policyVersion,
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
      workflow: "imessage_extraction", taskType: "subscription_imessage_extraction",
      model: input.model, promptVersion: IMESSAGE_EXTRACTION_PROMPT_VERSION,
      sourceHash: preview.sourceHash,
    },
    manifest: preview.manifest,
    auditManifest: preview.auditManifest,
  });
  return {
    cached: false, callId: call.callId, conversationStateHash: preview.conversationStateHash,
    promptVersion: imessagePromptSpec.version, promptSpecHash: imessagePromptSpec.specHash,
    instructions: renderInstructions(imessagePromptSpec, input.policyPrompt), schema: imessagePromptSpec.schema,
    context: preview.manifest.includedItems.map((item) => item.content),
    evidence: imessageEvidence(preview.manifest.includedItems, preview.deltaEvidenceIds),
    allowedEvidenceIds: imessageEvidence(preview.manifest.includedItems, preview.deltaEvidenceIds).map((item) => item.id),
  };
}

export async function submitSubscriptionIMessageExtraction(input: {
  adapter: IMessageSourceAdapter; store: OperationalStore; sourceId: string;
  selection: IMessageConversationSelection; callId: string;
  conversationStateHash: string; policyVersion: string; output: IMessageExtractionOutput;
  inputTokens?: number; outputTokens?: number; cachedTokens?: number;
  projectionRefresher?: PostExtractionRefresher;
}): Promise<{
  extractionId: string;
  output: IMessageExtractionOutput;
  projectionRefresh: PostExtractionRefreshReceipt;
}> {
  const { call, manifest } = requirePreparedReasoningCall({
    store: input.store, callId: input.callId,
    workflow: "imessage_extraction", taskType: "subscription_imessage_extraction",
    notFoundMessage: "prepared subscription Messages extraction call not found",
  });
  const prepared = preparedSourceIdentity(manifest.includedItems);
  const preparedPolicyVersion = findStringField(manifest.includedItems, "policy_version");
  const workId = findStringField(manifest.includedItems, "work_id");
  const leaseOwner = findStringField(manifest.includedItems, "work_lease_owner");
  const workSourceHash = findStringField(manifest.includedItems, "work_source_hash");
  const workContainerHash = findStringField(manifest.includedItems, "work_container_hash");
  if (!prepared || prepared.sourceHash !== call.sourceHash
    || prepared.conversationStateHash !== input.conversationStateHash
    || preparedPolicyVersion !== input.policyVersion) {
    throw new Error("prepared Messages source identity mismatch");
  }
  const imessageStore = new IMessageStore(input.store);
  if (!workId || !leaseOwner || !workSourceHash || !workContainerHash) {
    throw new Error("prepared Messages work identity is missing");
  }
  const workRepository = new WorkRepository(input.store);
  workRepository.requireLease({
    workId, leaseOwner, sourceHash: workSourceHash, containerHash: workContainerHash,
  });
  if (imessageStore.conversationStateHash(input.sourceId, prepared.conversationId)
    !== input.conversationStateHash) {
    workRepository.markStale({ workId });
    throw new Error("ingested Messages conversation changed; prepare extraction again");
  }
  assertContextStatesCurrent(input.store, manifest.includedItems);
  let current;
  try {
    current = await refetchIMessage({
      adapter: input.adapter, store: input.store, sourceId: input.sourceId,
      messageId: prepared.messageId, selection: input.selection,
    });
  } catch (error) {
    if (/changed|ingest again/i.test(error instanceof Error ? error.message : String(error))) {
      workRepository.markStale({ workId });
    }
    throw error;
  }
  if (current.sourceHash !== prepared.sourceHash) {
    workRepository.markStale({ workId });
    throw new Error("Messages source changed; prepare extraction again");
  }
  validateOutput(input.output, manifest.includedItems, prepared.deltaEvidenceIds);

  const completedAt = new Date().toISOString();
  const extractionId = newId("extract");
  const extraction = {
    sourceType: "imessage_extraction" as const, extractionId, callId: input.callId,
    output: input.output as unknown as Record<string, unknown>, createdAt: completedAt,
  };
  imessageStore.saveExtraction({
    extractionId, sourceId: input.sourceId, messageId: prepared.messageId,
    sourceHash: prepared.sourceHash, conversationId: prepared.conversationId,
    conversationStateHash: input.conversationStateHash, callId: input.callId,
    classification: input.output.classification,
    output: input.output as unknown as Record<string, unknown>,
    promptVersion: IMESSAGE_EXTRACTION_PROMPT_VERSION,
    schemaVersion: IMESSAGE_EXTRACTION_SCHEMA_VERSION,
    policyVersion: input.policyVersion, model: call.model, createdAt: completedAt, call,
    usage: {
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.cachedTokens !== undefined ? { cachedTokens: input.cachedTokens } : {}),
    }, findings: semanticFindingsForExtraction(extraction), workId, leaseOwner,
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
  messageId: string; conversationId: string; sourceHash: string;
  conversationStateHash: string; deltaEvidenceIds: string[];
} | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = preparedSourceIdentity(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message_id === "string" && typeof record.conversation_id === "string"
      && typeof record.evidence_id === "string"
      && typeof record.conversation_state_hash === "string") {
      const prefix = `imessage:${record.message_id}:`;
      if (record.evidence_id.startsWith(prefix)) {
        return {
          messageId: record.message_id, conversationId: record.conversation_id,
          sourceHash: record.evidence_id.slice(prefix.length),
          conversationStateHash: record.conversation_state_hash,
          deltaEvidenceIds: Array.isArray(record.delta_evidence_ids)
            ? record.delta_evidence_ids.map(String) : [record.evidence_id],
        };
      }
    }
    for (const item of Object.values(record)) {
      const found = preparedSourceIdentity(item);
      if (found) return found;
    }
  }
  return undefined;
}

function validateOutput(
  output: IMessageExtractionOutput, manifestItems: unknown[], deltaEvidenceIds: string[],
): void {
  if (!classifications.includes(output.classification) || !output.summary.trim()
    || !Array.isArray(output.items) || output.items.length > 20
    || !Array.isArray(output.unresolved) || typeof output.promptInjectionDetected !== "boolean") {
    throw new Error("Messages extraction output does not match the required schema");
  }
  enforceInjectionConsistency(output, manifestItems);
  const allowed = new Set(imessageEvidence(manifestItems, deltaEvidenceIds).map((item) => item.id));
  for (const item of output.items) {
    if (!item || typeof item !== "object" || !itemKinds.includes(item.kind)
      || typeof item.statement !== "string" || !item.statement.trim()
      || typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1
      || !extractionOwners.includes(item.owner) || !Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0
      || item.evidenceIds.some((evidence) => !allowed.has(evidence))
      || !(item.dueDate === null || typeof item.dueDate === "string")
      || !Array.isArray(item.ambiguities) || item.ambiguities.some((value) => typeof value !== "string")) {
      throw new Error("Messages extraction item contains invalid or unrecognized evidence");
    }
    if (!item.evidenceIds.some((evidence) => deltaEvidenceIds.includes(evidence))) {
      throw new Error("Messages extraction item must cite a newly changed message");
    }
  }
}

function imessageEvidence(value: unknown, deltaIds: string[]): EvidenceDescriptor[] {
  const records: EvidenceDescriptor[] = [];
  visitRecords(value, (record) => {
    const id = record.evidence_id;
    if (typeof id === "string" && /^imessage:imsg_[^:]+:sha256:/.test(id)) {
      records.push({ id, type: "provider_message", scope: deltaIds.includes(id) ? "delta" : "context" });
    } else if (typeof id === "string" && /^state:state_[A-Za-z0-9_-]+$/.test(id)) {
      records.push({ id, type: "state", scope: "context" });
    }
  });
  return [...new Map(records.map((item) => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

function assertContextStatesCurrent(store: OperationalStore, value: unknown): void {
  visitRecords(value, (record) => {
    if (typeof record.evidence_id !== "string" || !record.evidence_id.startsWith("state:")) return;
    if (typeof record.state_id !== "string" || typeof record.state_type !== "string") {
      throw new Error("prepared Messages contextual state identity is incomplete");
    }
    const entityId = typeof record.entity_id === "string" ? record.entity_id : undefined;
    const current = store.getCurrentDerivedState(record.state_type, entityId);
    if (!current || current.stateId !== record.state_id) {
      throw new Error("prepared Messages contextual state changed; prepare extraction again");
    }
  });
}

function enforceInjectionConsistency(output: IMessageExtractionOutput, value: unknown): void {
  const indicators: string[] = [];
  visitRecords(value, (record) => {
    if (Array.isArray(record.prompt_injection_indicators)) indicators.push(...record.prompt_injection_indicators.map(String));
  });
  if (output.promptInjectionDetected !== (indicators.length > 0)
    || output.classification === "malicious_or_untrusted_instruction" && !output.promptInjectionDetected) {
    throw new Error("Messages extraction contradicts deterministic prompt-injection indicators");
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
