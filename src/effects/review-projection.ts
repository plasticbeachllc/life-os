import type { ProposalRecord } from "../db/store";
import { reviewEffectProposal } from "./registry";
import { sha256Text } from "../util/hashing";

export interface SanitizedProposalReview {
  proposalId: string;
  actionId: string;
  workflow: string;
  lifecycleState: string;
  permissionClass: string;
  effectType: string;
  executorVersion: string;
  targetPath: string;
  expectedTargetHash: string;
  preview: string;
  createdAt: string;
  expiresAt: string | null;
  approved: boolean;
}

export function sanitizedProposalReview(proposal: ProposalRecord): SanitizedProposalReview {
  const review = reviewEffectProposal(proposal);
  return {
    proposalId: proposal.proposalId, actionId: proposal.actionId,
    workflow: proposal.workflow, lifecycleState: proposal.lifecycleState,
    permissionClass: proposal.permissionClass, effectType: proposal.effectType,
    executorVersion: proposal.executorVersion, targetPath: proposal.targetPath,
    expectedTargetHash: proposal.targetHash, preview: review.preview,
    createdAt: proposal.createdAt, expiresAt: proposal.expiresAt ?? null,
    approved: proposal.approved,
  };
}

export function browserProposalReview(proposal: ProposalRecord): {
  id: string; effectType: string; state: string; approval: "required" | "approved";
  preview: string; createdAt: string; expiresAt: string | null;
} {
  const review = sanitizedProposalReview(proposal);
  const preview = proposal.effectPlan.type === "frontmatter_patch"
    ? `Update ${Object.keys(proposal.effectPlan.additions).length} frontmatter field(s)`
    : proposal.effectPlan.type === "task_id_patch"
      ? `Add stable IDs to ${proposal.effectPlan.patches.length} task(s)`
      : proposal.effectPlan.type === "policy_bootstrap"
        ? `Create one required policy file (${proposal.effectPlan.content.split(/\r?\n/).length} lines)`
        : "Append one reviewed task to the fixed Inbox";
  return {
    id: `ui_${sha256Text(`proposal:${review.proposalId}`).slice(7, 27)}`,
    effectType: review.effectType, state: review.lifecycleState,
    approval: review.approved ? "approved" : "required", preview,
    createdAt: review.createdAt, expiresAt: review.expiresAt,
  };
}
