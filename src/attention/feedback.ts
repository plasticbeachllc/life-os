import {
  ATTENTION_PRESENTATION_POLICY_VERSION,
  type PresentationDecision,
} from "./presentation";

export const attentionFeedbackDispositions = [
  "useful", "incorrect", "duplicate", "already_handled",
  "irrelevant", "too_late", "too_intrusive",
] as const;

export type AttentionFeedbackDisposition = typeof attentionFeedbackDispositions[number];

export interface AttentionFeedbackRecord {
  attentionId: string;
  disposition: AttentionFeedbackDisposition;
  presentationChannel: Exclude<PresentationDecision["channel"], "suppress">;
  presentationReason: PresentationDecision["reason"];
  policyVersion: typeof ATTENTION_PRESENTATION_POLICY_VERSION;
  recordedAt: string;
}

export function compileAttentionFeedback(
  value: unknown, decision: PresentationDecision,
): AttentionFeedbackRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("attention feedback is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "attentionId,disposition,recordedAt") {
    throw new Error("attention feedback accepts only bounded structured fields");
  }
  if (record.attentionId !== decision.attention_id
    || typeof record.attentionId !== "string" || !/^attention_[A-Za-z0-9_-]+$/.test(record.attentionId)) {
    throw new Error("attention feedback does not match the presentation decision");
  }
  if (!attentionFeedbackDispositions.includes(record.disposition as never)) {
    throw new Error("attention feedback disposition is invalid");
  }
  if (decision.channel === "suppress") {
    throw new Error("suppressed attention cannot receive presentation feedback");
  }
  if (decision.policy_version !== ATTENTION_PRESENTATION_POLICY_VERSION) {
    throw new Error("attention feedback presentation policy is stale");
  }
  if (typeof record.recordedAt !== "string" || Number.isNaN(new Date(record.recordedAt).getTime())) {
    throw new Error("attention feedback timestamp is invalid");
  }
  return {
    attentionId: record.attentionId,
    disposition: record.disposition as AttentionFeedbackDisposition,
    presentationChannel: decision.channel,
    presentationReason: decision.reason,
    policyVersion: ATTENTION_PRESENTATION_POLICY_VERSION,
    recordedAt: record.recordedAt,
  };
}

