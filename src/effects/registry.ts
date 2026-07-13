import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore, ProposalRecord } from "../db/store";
import { FindingStore } from "../findings/store";
import { mandatoryPolicyFiles } from "../policy/loader";
import { sha256Text } from "../util/hashing";
import { frontmatterPatchPreview } from "../util/frontmatter-patch";
import { applyFindingTaskProposal } from "../tools/append-finding-task";
import { applyApprovedProposal } from "../tools/apply-frontmatter-patch";
import { applyTaskIdProposal } from "../tools/apply-task-id-patch";
import { applyPolicyBootstrapProposal } from "../tools/bootstrap-policy-file";
import {
  parseEffectPlan, requireEffectPlan, type EffectPlan, type EffectType,
} from "./contract";

export interface EffectReview {
  effectType: EffectType;
  executorVersion: string;
  preview: string;
}

export interface EffectApplicationInput {
  proposalId: string; vault: ObsidianVault; store: OperationalStore; backupRoot: string;
}

export interface EffectApplicationResult {
  actionId: string; targetPath: string; backupPath: string;
}

interface EffectExecutor<T extends EffectType> {
  effectType: T;
  version: string;
  permissionClass: "yellow";
  policyAction?: string;
  review(plan: Extract<EffectPlan, { type: T }>, proposal: ProposalRecord): string;
  assertSourceCurrent(proposal: ProposalRecord, plan: Extract<EffectPlan, { type: T }>, input: {
    vault: ObsidianVault; store: OperationalStore;
  }): Promise<void> | void;
  apply(input: EffectApplicationInput): Promise<EffectApplicationResult>;
}

const executors: { [T in EffectType]: EffectExecutor<T> } = {
  frontmatter_patch: {
    effectType: "frontmatter_patch", version: "frontmatter-patch-v1",
    permissionClass: "yellow", policyAction: "apply_frontmatter_patch",
    review: (plan) => frontmatterPatchPreview({ additions: plan.additions }),
    assertSourceCurrent: () => {}, apply: applyApprovedProposal,
  },
  task_id_patch: {
    effectType: "task_id_patch", version: "task-id-patch-v1",
    permissionClass: "yellow", policyAction: "create_task",
    review: (plan) => plan.patches.map((patch) =>
      `@@ line ${patch.line}\n+  <!-- life-os:task_id=${patch.taskId} -->`).join("\n"),
    assertSourceCurrent: () => {}, apply: applyTaskIdProposal,
  },
  policy_bootstrap: {
    effectType: "policy_bootstrap", version: "policy-bootstrap-v1",
    permissionClass: "yellow",
    review: (plan, proposal) => `+ create ${proposal.targetPath}\n+ ${plan.content.split(/\r?\n/).length} lines`,
    assertSourceCurrent: async (proposal, plan, { vault }) => {
      if (!new Set(Object.values(mandatoryPolicyFiles)).has(proposal.targetPath as never)) {
        throw new Error("policy bootstrap target is outside the allowlist");
      }
      if (plan.sourcePath) {
        const current = await Bun.file(vault.path(plan.sourcePath)).text();
        if (sha256Text(current) !== proposal.sourceHash) throw new Error("bootstrap source changed; regenerate proposal");
      } else if (sha256Text(plan.content) !== proposal.sourceHash) {
        throw new Error("generated bootstrap source changed; regenerate proposal");
      }
    },
    apply: applyPolicyBootstrapProposal,
  },
  finding_task_append: {
    effectType: "finding_task_append", version: "finding-task-append-v1",
    permissionClass: "yellow", policyAction: "create_task",
    review: (plan) => `+ ${plan.taskLine}\n+   <!-- life-os:task_id=${plan.taskId} source=${plan.findingId} -->`,
    assertSourceCurrent: (proposal, plan, { store }) => {
      const finding = new FindingStore(store).get(proposal.sourceId);
      if (!finding || finding.status !== "active" || finding.contentHash !== proposal.sourceHash
        || plan.findingId !== finding.findingId) {
        throw new Error("finding changed; regenerate task proposal");
      }
    },
    apply: applyFindingTaskProposal,
  },
};

export function getEffectExecutor<T extends EffectType>(effectType: T): EffectExecutor<T> {
  const executor = executors[effectType];
  if (!executor) throw new Error(`effect executor is not registered: ${effectType}`);
  return executor;
}

export function registeredEffectTypes(): EffectType[] {
  return Object.keys(executors).sort() as EffectType[];
}

export function reviewEffectProposal(proposal: ProposalRecord): EffectReview {
  const executor = getEffectExecutor(proposal.effectType);
  if (executor.version !== proposal.executorVersion) throw new Error("effect executor version changed; regenerate proposal");
  const plan = requireEffectPlan(proposal, proposal.effectType);
  return {
    effectType: proposal.effectType, executorVersion: executor.version,
    preview: executor.review(plan as never, proposal),
  };
}

export async function assertEffectSourceCurrent(input: {
  proposal: ProposalRecord; vault: ObsidianVault; store: OperationalStore;
}): Promise<void> {
  const executor = getEffectExecutor(input.proposal.effectType);
  if (executor.version !== input.proposal.executorVersion) {
    throw new Error("effect executor version changed; regenerate proposal");
  }
  const plan = requireEffectPlan(input.proposal, input.proposal.effectType);
  await executor.assertSourceCurrent(input.proposal, plan as never, input);
}

export function parseRegisteredEffectPlan(value: unknown): EffectPlan {
  const plan = parseEffectPlan(value);
  getEffectExecutor(plan.type);
  return plan;
}
