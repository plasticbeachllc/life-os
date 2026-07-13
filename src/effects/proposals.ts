import type { OperationalStore, ProposalRecord } from "../db/store";
import { effectPlanHash, type EffectPlan } from "./contract";
import { getEffectExecutor, parseRegisteredEffectPlan } from "./registry";

export function findCurrentEffectProposal(input: {
  store: OperationalStore; workflow: string; targetPath: string; targetHash: string;
  effectType: EffectPlan["type"];
}): ProposalRecord | undefined {
  const executor = getEffectExecutor(input.effectType);
  return input.store.findProposal(
    input.workflow, input.targetPath, input.targetHash, input.effectType, executor.version,
  );
}

export function createEffectProposal(input: {
  store: OperationalStore;
  proposalId: string; runId: string; actionId: string; workflow: string;
  sourceType: string; sourceId: string; sourceHash: string;
  targetPath: string; targetHash: string; plan: EffectPlan;
  createdAt: string; expiresAt?: string;
}): ProposalRecord {
  const plan = parseRegisteredEffectPlan(input.plan);
  const executor = getEffectExecutor(plan.type);
  const existing = input.store.findProposal(
    input.workflow, input.targetPath, input.targetHash, plan.type, executor.version,
  );
  if (existing) return existing;
  return input.store.createProposal({
    proposalId: input.proposalId, runId: input.runId, actionId: input.actionId,
    workflow: input.workflow, sourceType: input.sourceType, sourceId: input.sourceId,
    sourceHash: input.sourceHash, targetPath: input.targetPath, targetHash: input.targetHash,
    effectType: plan.type, effectPlan: plan,
    effectPlanHash: effectPlanHash({
      plan, executorVersion: executor.version,
      sourceType: input.sourceType, sourceId: input.sourceId, sourceHash: input.sourceHash,
      targetPath: input.targetPath, targetHash: input.targetHash,
    }),
    executorVersion: executor.version, permissionClass: executor.permissionClass,
    createdAt: input.createdAt, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });
}
