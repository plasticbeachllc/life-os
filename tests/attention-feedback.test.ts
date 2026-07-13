import { expect, test } from "bun:test";

import {
  attentionFeedbackDispositions, compileAttentionFeedback,
} from "../src/attention/feedback";
import type { PresentationDecision } from "../src/attention/presentation";

test("attention feedback is bound to the exact visible presentation decision", () => {
  const decision = presentationDecision("review_queue");
  for (const disposition of attentionFeedbackDispositions) {
    expect(compileAttentionFeedback({
      attentionId: decision.attention_id, disposition,
      recordedAt: "2026-07-12T10:00:00.000Z",
    }, decision)).toEqual({
      attentionId: decision.attention_id, disposition,
      presentationChannel: "review_queue", presentationReason: "reviewable_intervention",
      policyVersion: "attention-presentation-v1", recordedAt: "2026-07-12T10:00:00.000Z",
    });
  }
});

test("attention feedback rejects free text, mismatched identity, suppression, and stale policy", () => {
  const decision = presentationDecision("review_queue");
  const valid = {
    attentionId: decision.attention_id, disposition: "useful",
    recordedAt: "2026-07-12T10:00:00.000Z",
  };
  expect(() => compileAttentionFeedback({ ...valid, comment: "private source prose" }, decision))
    .toThrow("only bounded structured fields");
  expect(() => compileAttentionFeedback({ ...valid, attentionId: "attention_other" }, decision))
    .toThrow("does not match");
  expect(() => compileAttentionFeedback(valid, presentationDecision("suppress")))
    .toThrow("suppressed attention");
  expect(() => compileAttentionFeedback(valid, {
    ...decision, policy_version: "attention-presentation-old" as never,
  })).toThrow("policy is stale");
  expect(() => compileAttentionFeedback({ ...valid, disposition: "freeform" }, decision))
    .toThrow("disposition is invalid");
});

function presentationDecision(channel: PresentationDecision["channel"]): PresentationDecision {
  return {
    attention_id: "attention_feedback", channel,
    reason: channel === "suppress" ? "low_value_no_action" : "reviewable_intervention",
    explanation: "Fixture presentation decision.", policy_version: "attention-presentation-v1",
  };
}

