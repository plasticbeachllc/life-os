import { buildContext, type ContextCandidate } from "../context/builder";
import type { DerivedStateRecord, OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";
import { newId } from "../util/ids";
import { morningPromptSpec } from "../orchestration/prompt-contracts";
import { promptContext, renderInstructions, type CompiledPolicyPrompt, type EvidenceDescriptor } from "../orchestration/prompt-spec";

export interface SubscriptionRecommendation {
  summary: string;
  reason: string;
  evidenceIds: string[];
  confidence: number;
}

export function prepareSubscriptionMorningReasoning(input: {
  store: OperationalStore; model: string; policyVersion: string; policyPrompt?: CompiledPolicyPrompt;
}): {
  cached: boolean; callId?: string; state?: DerivedStateRecord;
  instructions?: string; context?: unknown[]; allowedEvidenceIds?: string[];
  promptVersion?: string; promptSpecHash?: string; schema?: Record<string, unknown>;
  evidence?: EvidenceDescriptor[];
} {
  const daily = input.store.listCurrentDerivedStates("daily_state").at(-1);
  const chief = input.store.getCurrentDerivedState("chief_of_staff_state");
  if (!daily || !chief) throw new Error("daily and chief-of-staff state are required");
  const sourceHash = sha256Value([
    daily.stateId, daily.stateVersion, chief.stateId, chief.stateVersion,
    input.policyVersion, morningPromptSpec.specHash,
  ]);
  const prior = input.store.getCurrentDerivedState("briefing_reasoning_state", daily.entityId);
  if (prior?.sourceHashes.includes(sourceHash)) return { cached: true, state: prior };
  const candidates: ContextCandidate[] = [
    compactCandidate(chief), compactCandidate(daily),
    {
      id: `policy:${morningPromptSpec.version}`, category: "policy", retrievalLevel: 0,
      content: input.policyPrompt ? promptContext(morningPromptSpec, input.policyPrompt) : {
        prompt_contract: { workflow: morningPromptSpec.workflow, spec_hash: morningPromptSpec.specHash, rules: morningPromptSpec.rules },
      },
      tokenEstimate: Math.ceil(JSON.stringify(input.policyPrompt ? promptContext(morningPromptSpec, input.policyPrompt) : morningPromptSpec.rules).length / 4),
      relevance: 1, impact: 1,
      sourceRefs: [morningPromptSpec.specHash, input.policyVersion],
    },
  ];
  const manifest = buildContext(candidates, {
    maxInputTokens: 3000, reservedOutputTokens: 700, sourceTokens: 0,
    entityStateTokens: 2200, recentChangeTokens: 0, policyTokens: 400, contingencyTokens: 400,
  });
  const callId = newId("call");
  const startedAt = new Date().toISOString();
  input.store.recordModelCall({
    callId, workflow: "morning_briefing", taskType: "subscription_synthesis",
    model: input.model, promptVersion: morningPromptSpec.version, sourceHash,
    contextHash: manifest.contextHash, cached: false, startedAt, status: "prepared",
  });
  input.store.recordContextManifest({
    manifestId: manifest.manifestId, callId, includedItems: manifest.includedItems,
    omittedItems: manifest.omittedItems, tokenBudget: manifest.tokenBudget,
    retrievalLevels: manifest.retrievalLevels, rankingVersion: manifest.rankingVersion,
    contextHash: manifest.contextHash, createdAt: manifest.createdAt,
  });
  return {
    cached: false, callId,
    promptVersion: morningPromptSpec.version, promptSpecHash: morningPromptSpec.specHash,
    instructions: renderInstructions(morningPromptSpec, input.policyPrompt), schema: morningPromptSpec.schema,
    context: manifest.includedItems.map((item) => item.content),
    evidence: morningEvidenceDescriptors(manifest.includedItems),
    allowedEvidenceIds: morningEvidenceDescriptors(manifest.includedItems).map((item) => item.id),
  };
}

export function submitSubscriptionMorningReasoning(input: {
  store: OperationalStore; callId: string; recommendations: SubscriptionRecommendation[];
  inputTokens?: number; outputTokens?: number; cachedTokens?: number;
}): DerivedStateRecord {
  const call = input.store.getModelCall(input.callId);
  if (!call || call.status !== "prepared" || call.taskType !== "subscription_synthesis") {
    throw new Error("prepared subscription reasoning call not found");
  }
  const manifest = input.store.getContextManifestForCall(input.callId);
  if (!manifest || manifest.contextHash !== call.contextHash) throw new Error("context manifest mismatch");
  validateRecommendations(input.recommendations);
  const allowed = new Set(morningEvidenceDescriptors(manifest.includedItems).map((item) => item.id));
  for (const recommendation of input.recommendations) {
    if (recommendation.confidence < 0 || recommendation.confidence > 1) throw new Error("recommendation confidence must be between 0 and 1");
    if (recommendation.evidenceIds.length === 0 || recommendation.evidenceIds.some((id) => !allowed.has(id))) {
      throw new Error("recommendation contains missing or unrecognized evidence IDs");
    }
  }
  const daily = input.store.listCurrentDerivedStates("daily_state").at(-1);
  if (!daily || !call.sourceHash) throw new Error("daily state or source hash is missing");
  const prior = input.store.getCurrentDerivedState("briefing_reasoning_state", daily.entityId);
  const completedAt = new Date().toISOString();
  const state: DerivedStateRecord = {
    stateId: newId("state"), stateType: "briefing_reasoning_state",
    ...(daily.entityId ? { entityId: daily.entityId } : {}),
    stateVersion: (prior?.stateVersion ?? 0) + 1,
    content: { recommendations: input.recommendations, call_id: input.callId },
    sourceHashes: [call.sourceHash], generationMethod: "subscription-agent-reasoning-v1",
    promptVersion: call.promptVersion, model: call.model, createdAt: completedAt,
  };
  input.store.saveDerivedState(state);
  input.store.recordModelCall({
    ...call,
    ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
    ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
    ...(input.cachedTokens !== undefined ? { cachedTokens: input.cachedTokens } : {}),
    completedAt, status: "completed",
  });
  return state;
}

function compactCandidate(state: DerivedStateRecord): ContextCandidate {
  return {
    id: state.stateId, category: "entity_state", retrievalLevel: 1,
    content: state.content, tokenEstimate: Math.ceil(JSON.stringify(state.content).length / 4),
    relevance: 1, impact: 1, recency: 1,
    sourceRefs: [state.stateId, ...(state.entityId ? [state.entityId] : []), ...state.sourceHashes],
  };
}

export function validateRecommendations(value: unknown): asserts value is SubscriptionRecommendation[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error("morning recommendations do not match the required schema");
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("morning recommendations do not match the required schema");
    const record = item as Record<string, unknown>;
    if (typeof record.summary !== "string" || !record.summary.trim()
      || typeof record.reason !== "string" || !record.reason.trim()
      || !Array.isArray(record.evidenceIds) || record.evidenceIds.length === 0
      || typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1) {
      throw new Error("morning recommendations do not match the required schema");
    }
  }
}

export function morningEvidenceDescriptors(items: unknown[]): EvidenceDescriptor[] {
  const result: EvidenceDescriptor[] = [];
  for (const value of items) {
    if (!value || typeof value !== "object") continue;
    const item = value as ContextCandidate;
    if (item.category === "policy") continue;
    for (const id of item.sourceRefs) {
      if (/^(state|task|person|project|goal|change)_|^obsidian:/.test(id)) {
        result.push({ id, type: id.startsWith("state_") ? "state" : id.startsWith("change_") ? "change" : "entity", scope: "context" });
      }
    }
    if (item.id.startsWith("state_")) result.push({ id: item.id, type: "state", scope: "context" });
    collectDeclaredEvidence(item.content, result);
  }
  return [...new Map(result.map((item) => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

function collectDeclaredEvidence(value: unknown, result: EvidenceDescriptor[]): void {
  if (Array.isArray(value)) for (const item of value) collectDeclaredEvidence(item, result);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "evidenceIds" || key === "evidence_ids") && Array.isArray(item)) {
        for (const id of item) if (typeof id === "string" && !id.startsWith("sha256:")) {
          result.push({ id, type: id.startsWith("change_") ? "change" : id.startsWith("state_") ? "state" : "entity", scope: "context" });
        }
      } else collectDeclaredEvidence(item, result);
    }
  }
}
