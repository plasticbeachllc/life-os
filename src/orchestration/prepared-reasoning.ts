import type { ContextManifest } from "../context/builder";
import type { PersistableContextManifest } from "../context/manifests";
import type { ModelCallRecord, OperationalStore } from "../db/store";
import { newId } from "../util/ids";

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
}): { call: ModelCallRecord; manifest: { includedItems: unknown[]; contextHash: string } } {
  const call = input.store.getModelCall(input.callId);
  if (!call || call.status !== "prepared"
    || call.workflow !== input.workflow || call.taskType !== input.taskType) {
    throw new Error(input.notFoundMessage);
  }
  const manifest = input.store.getContextManifestForCall(input.callId);
  if (!manifest || manifest.contextHash !== call.contextHash) {
    throw new Error("context manifest mismatch");
  }
  return { call, manifest };
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
