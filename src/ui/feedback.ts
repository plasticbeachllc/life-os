import type { OperationalStore } from "../db/store";
import { compileAttentionFeedback, attentionFeedbackDispositions } from "../attention/feedback";
import { compileAttentionReview } from "../attention/review";
import { ATTENTION_PRESENTATION_POLICY_VERSION } from "../attention/presentation";
import { sha256Text } from "../util/hashing";
import { newId } from "../util/ids";

const uiAttentionQualityOutcomes = [
  "useful", "incorrect", "duplicate", "irrelevant", "too_late", "too_intrusive",
] as const;

export type UiFeedbackInput =
  | { subjectKind: "finding"; subjectUiId: string; outcome: "useful" | "not_useful" }
  | { subjectKind: "proposal"; subjectUiId: string; outcome: "accepted" | "rejected" }
  | { subjectKind: "attention"; subjectUiId: string;
    outcome: typeof uiAttentionQualityOutcomes[number] };

export function parseUiFeedback(value: unknown): UiFeedbackInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid feedback");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["subjectKind", "subjectUiId", "outcome"].includes(key))
    || !["finding", "proposal", "attention"].includes(String(input.subjectKind))
    || typeof input.subjectUiId !== "string" || !/^ui_[a-f0-9]{20}$/.test(input.subjectUiId)
    || !["useful", "not_useful", "accepted", "rejected", ...attentionFeedbackDispositions]
      .includes(input.outcome as never)) {
    throw new Error("invalid feedback");
  }
  if (input.subjectKind === "finding" && !["useful", "not_useful"].includes(String(input.outcome))) {
    throw new Error("invalid finding feedback outcome");
  }
  if (input.subjectKind === "proposal" && !["accepted", "rejected"].includes(String(input.outcome))) {
    throw new Error("invalid proposal feedback outcome");
  }
  if (input.subjectKind === "attention" && !uiAttentionQualityOutcomes.includes(input.outcome as never)) {
    throw new Error("invalid attention feedback outcome");
  }
  return {
    subjectKind: input.subjectKind,
    subjectUiId: input.subjectUiId,
    outcome: input.outcome,
  } as UiFeedbackInput;
}

export function recordUiFeedback(input: { store: OperationalStore; value: unknown; now?: Date }): string {
  const feedback = parseUiFeedback(input.value);
  if (feedback.subjectKind === "attention") {
    return recordAttentionUiDisposition({ store: input.store, subjectUiId: feedback.subjectUiId,
      outcome: feedback.outcome, now: input.now ?? new Date() });
  }
  const feedbackId = newId("feedback");
  input.store.recordUiFeedback({ feedbackId, ...feedback, createdAt: new Date().toISOString() });
  return feedbackId;
}

export function attentionSubjectUiId(input: {
  attentionId: string; presentationChannel: "review_queue" | "morning_briefing" | "immediate_notification";
  presentationReason: string; policyVersion: string;
}): string {
  if (!/^attention_[A-Za-z0-9_-]+$/.test(input.attentionId)
    || !input.presentationReason || input.policyVersion !== ATTENTION_PRESENTATION_POLICY_VERSION) {
    throw new Error("invalid attention presentation identity");
  }
  const identity = [input.attentionId, input.presentationChannel,
    input.presentationReason, input.policyVersion].join(":");
  return `ui_${sha256Text(`attention:${identity}`).slice("sha256:".length, "sha256:".length + 20)}`;
}

export function recordAttentionUiDisposition(input: {
  store: OperationalStore; subjectUiId: string;
  outcome: typeof attentionFeedbackDispositions[number]; now: Date;
}): string {
  const state = input.store.getCurrentDerivedState("finding_attention_state");
  if (!state) throw new Error("current attention state is unavailable");
  const item = compileAttentionReview(state).items.find((candidate) =>
    attentionSubjectUiId({
      attentionId: candidate.attentionId, presentationChannel: candidate.presentation.channel,
      presentationReason: candidate.presentation.reason, policyVersion: candidate.presentation.policyVersion,
    }) === input.subjectUiId);
  if (!item) throw new Error("attention feedback subject is not currently reviewable");
  const record = compileAttentionFeedback({
    attentionId: item.attentionId, disposition: input.outcome,
    recordedAt: input.now.toISOString(),
  }, {
    attention_id: item.attentionId, channel: item.presentation.channel,
    reason: item.presentation.reason, explanation: item.presentation.explanation,
    policy_version: ATTENTION_PRESENTATION_POLICY_VERSION,
  });
  const identity = [record.attentionId, record.presentationChannel,
    record.presentationReason, record.policyVersion].join(":");
  const feedbackId = `feedback_${sha256Text(identity).slice("sha256:".length, "sha256:".length + 24)}`;
  const interventionLevel = item.interventions.some((intervention) => intervention.readiness === "ready") ? 4
    : item.ambiguities.length > 0
      || item.interventions.some((intervention) => intervention.readiness === "needs_clarification") ? 3 : 2;
  input.store.recordAttentionFeedback({
    feedbackId, ...record, signalType: item.type, interventionLevel,
  });
  return feedbackId;
}
