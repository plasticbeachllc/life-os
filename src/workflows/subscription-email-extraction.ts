import type { GmailSourceAdapter } from "../adapters/gmail";
import type { ContextCandidate } from "../context/builder";
import { persistableContextManifest } from "../context/manifests";
import type { OperationalStore } from "../db/store";
import {
  EMAIL_EXTRACTION_PROMPT_VERSION,
  EMAIL_EXTRACTION_SCHEMA_VERSION,
} from "../gmail/extraction-contract";
import { GmailStore } from "../gmail/store";
import { newId } from "../util/ids";
import { extractionClassifications as classifications, extractionItemKinds as itemKinds, extractionOwners, gmailPromptSpec } from "../orchestration/prompt-contracts";
import { renderInstructions, type CompiledPolicyPrompt, type EvidenceDescriptor } from "../orchestration/prompt-spec";
import {
  completeReasoningCall, prepareReasoningCall, requirePreparedReasoningCall,
} from "../orchestration/prepared-reasoning";
import { previewGmailExtractionContext } from "./gmail-extraction-preview";

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
  const preview = await previewGmailExtractionContext(input);
  if (!preview) return { cached: false, empty: true, message: "No unextracted important messages." };
  const cached = gmailStore.findExtraction({
    accountId: input.accountId, messageId: preview.messageId, sourceHash: preview.sourceHash,
    promptVersion: EMAIL_EXTRACTION_PROMPT_VERSION,
    schemaVersion: EMAIL_EXTRACTION_SCHEMA_VERSION, policyVersion: input.policyVersion,
  });
  if (cached) return { cached: true, extractionId: cached.extractionId, output: cached.output };

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
    if (["untrusted_authored_text", "authored_excerpt", "subject", "from", "to", "cc"].includes(key)) return [];
    return [[key, stripSourceText(item)]];
  }));
}

export async function submitSubscriptionEmailExtraction(input: {
  store: OperationalStore; accountId: string;
  callId: string; threadStateHash: string; policyVersion: string; output: EmailExtractionOutput;
  inputTokens?: number; outputTokens?: number; cachedTokens?: number;
}): Promise<{ extractionId: string; output: EmailExtractionOutput }> {
  const { call, manifest } = requirePreparedReasoningCall({
    store: input.store, callId: input.callId,
    workflow: "gmail_extraction", taskType: "subscription_email_extraction",
    notFoundMessage: "prepared subscription email extraction call not found",
  });
  const preparedSource = preparedSourceIdentity(manifest.includedItems);
  const preparedPolicyVersion = findStringField(manifest.includedItems, "policy_version");
  if (preparedPolicyVersion !== input.policyVersion) {
    throw new Error("prepared Gmail policy version mismatch; prepare extraction again");
  }
  const gmailStore = new GmailStore(input.store);
  if (!preparedSource || preparedSource.sourceHash !== call.sourceHash
    || preparedSource.threadStateHash !== input.threadStateHash
    || gmailStore.currentMessageHash(input.accountId, preparedSource.messageId) !== call.sourceHash
    || gmailStore.currentThreadHash(input.accountId, preparedSource.threadId) !== input.threadStateHash) {
    throw new Error("ingested Gmail source or thread changed; prepare extraction again");
  }
  validateOutput(input.output, manifest.includedItems, call.sourceHash);

  const completedAt = new Date().toISOString();
  const extractionId = newId("extract");
  gmailStore.saveExtraction({
    extractionId, accountId: input.accountId, messageId: preparedSource.messageId,
    sourceHash: preparedSource.sourceHash, threadStateHash: preparedSource.threadStateHash,
    callId: input.callId, classification: input.output.classification,
    output: input.output as unknown as Record<string, unknown>,
    promptVersion: EMAIL_EXTRACTION_PROMPT_VERSION,
    schemaVersion: EMAIL_EXTRACTION_SCHEMA_VERSION, policyVersion: input.policyVersion,
    model: call.model, createdAt: completedAt,
  });
  completeReasoningCall({
    store: input.store, call,
    usage: {
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.cachedTokens !== undefined ? { cachedTokens: input.cachedTokens } : {}),
    },
    now: new Date(completedAt),
  });
  return { extractionId, output: input.output };
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
    || !Array.isArray(output.unresolved) || typeof output.promptInjectionDetected !== "boolean") {
    throw new Error("email extraction output does not match the required schema");
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
