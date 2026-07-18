import type { OperationalStore } from "../db/store";
import { recordAttentionUiDisposition } from "./feedback";

/** Marks one exact, currently reviewable attention presentation as handled. */
export function markAttentionHandledFromUi(input: {
  store: OperationalStore; subjectUiId: string; now?: Date;
}): string {
  return recordAttentionUiDisposition({ store: input.store, subjectUiId: input.subjectUiId,
    outcome: "already_handled", now: input.now ?? new Date() });
}
