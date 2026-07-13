import type { OperationalStore } from "../db/store";
import { rebuildChiefOfStaffState } from "../state/chief-of-staff";
import { rebuildFindingAttentionState } from "../state/finding-attention";

export type PostExtractionRefreshReceipt =
  | {
    status: "completed";
    attentionStateVersion: number;
    chiefOfStaffStateVersion: number;
  }
  | {
    status: "failed";
    errorCategory: "projection_refresh_failed";
  };

export type PostExtractionRefresher = typeof refreshAfterExtraction;

type ProjectionRefresher = (input: {
  store: OperationalStore;
  now: Date;
}) => { attentionStateVersion: number; chiefOfStaffStateVersion: number };

export function refreshAfterExtraction(input: {
  store: OperationalStore;
  now?: Date;
  refresher?: ProjectionRefresher;
}): PostExtractionRefreshReceipt {
  try {
    return {
      status: "completed",
      ...(input.refresher ?? rebuildAttentionProjectionSet)({
        store: input.store, now: input.now ?? new Date(),
      }),
    };
  } catch {
    return { status: "failed", errorCategory: "projection_refresh_failed" };
  }
}

function rebuildAttentionProjectionSet(input: {
  store: OperationalStore;
  now: Date;
}): { attentionStateVersion: number; chiefOfStaffStateVersion: number } {
  const attention = rebuildFindingAttentionState(input);
  const chief = rebuildChiefOfStaffState(input);
  return {
    attentionStateVersion: attention.stateVersion,
    chiefOfStaffStateVersion: chief.stateVersion,
  };
}
