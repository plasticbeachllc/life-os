import type { ContextManifest } from "../context/builder";
import type { PersistableContextManifest } from "../context/manifests";
import type { ModelCallRecord, OperationalStore } from "../db/store";
import { newId } from "../util/ids";
import { markWorkStaleInTransaction } from "../work/repository";

export interface PreparedReasoningIdentity {
  workflow: string;
  taskType: string;
  model: string;
  promptVersion: string;
  sourceHash?: string;
}

export interface PreparedReasoningUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export type ReasoningRunState = "prepared" | "completed" | "failed" | "superseded";
export type ReasoningErrorCategory = "invalid_output" | "stale_source" | "policy_changed"
  | "context_changed" | "expired" | "provider_unavailable" | "internal_failure";

export const defaultPreparedCallTtlMs = 30 * 60 * 1000;

export function prepareReasoningCall(input: {
  store: OperationalStore;
  identity: PreparedReasoningIdentity;
  manifest: ContextManifest;
  auditManifest?: PersistableContextManifest;
  now?: Date;
}): ModelCallRecord {
  const call: ModelCallRecord = {
    callId: newId("call"),
    workflow: input.identity.workflow,
    taskType: input.identity.taskType,
    model: input.identity.model,
    promptVersion: input.identity.promptVersion,
    ...(input.identity.sourceHash ? { sourceHash: input.identity.sourceHash } : {}),
    contextHash: input.manifest.contextHash,
    cached: false,
    startedAt: (input.now ?? new Date()).toISOString(),
    status: "prepared",
  };
  input.store.recordModelCall(call);
  const audit = input.auditManifest ?? input.manifest;
  input.store.recordContextManifest({
    manifestId: audit.manifestId,
    callId: call.callId,
    includedItems: audit.includedItems,
    omittedItems: audit.omittedItems,
    tokenBudget: audit.tokenBudget,
    retrievalLevels: audit.retrievalLevels,
    rankingVersion: audit.rankingVersion,
    contextHash: audit.contextHash,
    createdAt: audit.createdAt,
  });
  return call;
}

export function requirePreparedReasoningCall(input: {
  store: OperationalStore;
  callId: string;
  workflow: string;
  taskType: string;
  notFoundMessage: string;
  now?: Date;
  maxAgeMs?: number;
}): { call: ModelCallRecord; manifest: { includedItems: unknown[]; contextHash: string } } {
  const call = input.store.getModelCall(input.callId);
  if (!call || call.status !== "prepared"
    || call.workflow !== input.workflow || call.taskType !== input.taskType) {
    throw new Error(input.notFoundMessage);
  }
  const now = input.now ?? new Date();
  const maxAgeMs = input.maxAgeMs ?? defaultPreparedCallTtlMs;
  if (maxAgeMs <= 0 || now.getTime() - new Date(call.startedAt).getTime() > maxAgeMs) {
    throw new Error("prepared reasoning call has expired");
  }
  const manifest = input.store.getContextManifestForCall(input.callId);
  if (!manifest || manifest.contextHash !== call.contextHash) {
    throw new Error("context manifest mismatch");
  }
  return { call, manifest };
}

export function failReasoningCall(input: {
  store: OperationalStore; call: ModelCallRecord; category: ReasoningErrorCategory;
  now?: Date;
}): ModelCallRecord {
  if (input.call.status !== "prepared") throw new Error("only a prepared reasoning call can fail");
  const failed: ModelCallRecord = {
    ...input.call, status: "failed", error: input.category,
    completedAt: (input.now ?? new Date()).toISOString(),
  };
  input.store.recordModelCall(failed);
  return failed;
}

export function failReasoningCallInTransaction(
  db: ReturnType<OperationalStore["open"]>,
  input: { call: ModelCallRecord; category: ReasoningErrorCategory; completedAt: string },
): void {
  const result = db.query(`
    UPDATE model_calls SET completed_at = ?, status = 'failed', error = ?
    WHERE call_id = ? AND status = 'prepared' AND workflow = ? AND task_type = ?
      AND context_hash = ?
  `).run(input.completedAt, input.category, input.call.callId, input.call.workflow,
    input.call.taskType, input.call.contextHash);
  if (result.changes !== 1) throw new Error("prepared reasoning call changed before failure recording");
}

/**
 * Source/context drift makes both the prepared call and its leased work terminal.
 * Keeping this in one transaction prevents a revivable model call or stranded lease.
 */
export function failPreparedCallAndMarkWorkStale(input: {
  store: OperationalStore; call: ModelCallRecord; workId: string;
  category: Extract<ReasoningErrorCategory, "stale_source" | "context_changed" | "policy_changed">;
  now?: Date;
}): void {
  const db = input.store.open();
  const completedAt = (input.now ?? new Date()).toISOString();
  try {
    db.transaction(() => {
      failReasoningCallInTransaction(db, { call: input.call, category: input.category, completedAt });
      markWorkStaleInTransaction(db, { workId: input.workId, updatedAt: completedAt });
    })();
  } finally { db.close(); }
}

export function completeReasoningCall(input: {
  store: OperationalStore;
  call: ModelCallRecord;
  usage?: PreparedReasoningUsage;
  now?: Date;
}): ModelCallRecord {
  const completed: ModelCallRecord = {
    ...input.call,
    ...(input.usage?.inputTokens !== undefined ? { inputTokens: input.usage.inputTokens } : {}),
    ...(input.usage?.outputTokens !== undefined ? { outputTokens: input.usage.outputTokens } : {}),
    ...(input.usage?.cachedTokens !== undefined ? { cachedTokens: input.usage.cachedTokens } : {}),
    completedAt: (input.now ?? new Date()).toISOString(),
    status: "completed",
  };
  input.store.recordModelCall(completed);
  return completed;
}

export function completeReasoningCallInTransaction(
  db: ReturnType<OperationalStore["open"]>,
  input: { call: ModelCallRecord; usage?: PreparedReasoningUsage; completedAt: string },
): void {
  const result = db.query(`
    UPDATE model_calls SET input_tokens = ?, output_tokens = ?, cached_tokens = ?,
      completed_at = ?, status = 'completed', error = NULL
    WHERE call_id = ? AND status = 'prepared' AND workflow = ? AND task_type = ?
      AND context_hash = ?
  `).run(
    input.usage?.inputTokens ?? null, input.usage?.outputTokens ?? null,
    input.usage?.cachedTokens ?? null, input.completedAt, input.call.callId,
    input.call.workflow, input.call.taskType, input.call.contextHash,
  );
  if (result.changes !== 1) throw new Error("prepared reasoning call changed before completion");
}
