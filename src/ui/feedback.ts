import type { OperationalStore } from "../db/store";
import { newId } from "../util/ids";

export interface UiFeedbackInput {
  subjectKind: "finding" | "proposal";
  subjectUiId: string;
  outcome: "useful" | "not_useful" | "accepted" | "rejected";
}

export function parseUiFeedback(value: unknown): UiFeedbackInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid feedback");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["subjectKind", "subjectUiId", "outcome"].includes(key))
    || !["finding", "proposal"].includes(String(input.subjectKind))
    || typeof input.subjectUiId !== "string" || !/^ui_[a-f0-9]{20}$/.test(input.subjectUiId)
    || !["useful", "not_useful", "accepted", "rejected"].includes(String(input.outcome))) {
    throw new Error("invalid feedback");
  }
  if (input.subjectKind === "finding" && !["useful", "not_useful"].includes(String(input.outcome))) {
    throw new Error("invalid finding feedback outcome");
  }
  if (input.subjectKind === "proposal" && !["accepted", "rejected"].includes(String(input.outcome))) {
    throw new Error("invalid proposal feedback outcome");
  }
  return {
    subjectKind: input.subjectKind as UiFeedbackInput["subjectKind"],
    subjectUiId: input.subjectUiId,
    outcome: input.outcome as UiFeedbackInput["outcome"],
  };
}

export function recordUiFeedback(input: { store: OperationalStore; value: unknown }): string {
  const feedback = parseUiFeedback(input.value);
  const feedbackId = newId("feedback");
  input.store.recordUiFeedback({ feedbackId, ...feedback, createdAt: new Date().toISOString() });
  return feedbackId;
}
