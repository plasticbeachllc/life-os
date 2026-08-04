import type { ObsidianVault } from "../adapters/obsidian";
import { compileAttentionReview } from "../attention/review";
import type { AttentionReviewItem } from "../attention/review";
import type { OperationalStore, ProposalRecord } from "../db/store";
import { browserProposalReview, browserTaskProposalCanApply } from "../effects/review-projection";
import { FindingStore } from "../findings/store";
import { canProposeFindingTask, proposeFindingTask } from "../workflows/finding-task-proposal";
import { attentionSubjectUiId } from "./feedback";
import { sha256Text } from "../util/hashing";

const uiIdPattern = /^ui_[a-f0-9]{20}$/;

export function attentionFromUi(input: {
  attentionUiId: string; store: OperationalStore;
}): AttentionReviewItem | undefined {
  if (!uiIdPattern.test(input.attentionUiId)) throw new Error("invalid attention review identity");
  const state = input.store.getCurrentDerivedState("finding_attention_state");
  if (!state) throw new Error("current attention state is unavailable");
  return compileAttentionReview(state).items.find((candidate) =>
    attentionSubjectUiId({
      attentionId: candidate.attentionId,
      presentationChannel: candidate.presentation.channel,
      presentationReason: candidate.presentation.reason,
      policyVersion: candidate.presentation.policyVersion,
    }) === input.attentionUiId);
}

export function requireAttentionFromUi(input: {
  attentionUiId: string; store: OperationalStore;
}): AttentionReviewItem {
  const item = attentionFromUi(input);
  if (!item) throw new Error("attention item is not currently reviewable");
  return item;
}

export async function proposeAttentionTaskFromUi(input: {
  attentionUiId: string;
  vault: ObsidianVault;
  store: OperationalStore;
}): Promise<ReturnType<typeof browserProposalReview>> {
  const item = attentionFromUi({ attentionUiId: input.attentionUiId, store: input.store });
  if (!item || !item.interventions.some((intervention) =>
    intervention.kind === "create_task" && intervention.readiness === "ready")) {
    throw new Error("attention item does not have a ready task intervention");
  }
  const findingStore = new FindingStore(input.store);
  const eligible = item.findingIds
    .map((findingId) => findingStore.get(findingId))
    .filter((finding): finding is NonNullable<typeof finding> =>
      Boolean(finding && canProposeFindingTask(finding)));
  if (eligible.length !== 1) throw new Error("attention task intervention is not singular and actionable");
  const proposal = await proposeFindingTask({
    findingId: eligible[0]!.findingId,
    vault: input.vault,
    store: input.store,
  });
  return browserProposalReview(proposal);
}

export function requirePendingTaskProposalFromUi(input: {
  proposalUiId: string;
  store: OperationalStore;
}): ProposalRecord {
  if (!uiIdPattern.test(input.proposalUiId)) throw new Error("invalid proposal review identity");
  const proposal = input.store.listPendingProposals().find((candidate) =>
    browserProposalReview(candidate).id === input.proposalUiId);
  if (!proposal || proposal.effectType !== "finding_task_append"
    || !browserTaskProposalCanApply(proposal)) {
    throw new Error("task proposal is not currently reviewable");
  }
  return proposal;
}

export function actionUiId(actionId: string): string {
  return `ui_${sha256Text(`action:${actionId}`).slice("sha256:".length, "sha256:".length + 20)}`;
}

export function requireUndoableTaskActionFromUi(input: {
  actionUiId: string;
  store: OperationalStore;
}): { actionId: string; proposal: ProposalRecord } {
  if (!uiIdPattern.test(input.actionUiId)) throw new Error("invalid action review identity");
  const action = input.store.listRecentActionReviews(100).find((candidate) =>
    actionUiId(candidate.actionId) === input.actionUiId);
  if (!action || action.effectType !== "finding_task_append" || !action.undoAvailable || action.undone) {
    throw new Error("task action is not currently undoable");
  }
  const proposal = input.store.getProposalByActionId(action.actionId);
  if (!proposal || proposal.lifecycleState !== "applied") throw new Error("applied task proposal is unavailable");
  return { actionId: action.actionId, proposal };
}
