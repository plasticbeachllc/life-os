import { describe, expect, test } from "bun:test";

import type { AttentionSignal } from "../src/attention/contract";
import {
  ATTENTION_PRESENTATION_POLICY_VERSION,
  routeAttentionPresentation,
  type ValidatedInterruptionContext,
} from "../src/attention/presentation";
import { resolveAttention } from "../src/attention/resolver";
import { attentionEvaluationCorpus } from "./fixtures/attention-evaluation";

describe("attention evaluation corpus", () => {
  for (const evaluation of attentionEvaluationCorpus) {
    test(evaluation.name, () => {
      const resolution = resolveAttention({
        activeFindings: evaluation.findings, tasks: evaluation.tasks, now: evaluation.now,
        ...(evaluation.communicationContexts
          ? { communicationContexts: evaluation.communicationContexts } : {}),
        ...(evaluation.relations ? { relations: evaluation.relations } : {}),
      });
      const interruptionContexts: ValidatedInterruptionContext[] = [];
      if (evaluation.interruption) {
        const { signalType, ...context } = evaluation.interruption;
        const signal = resolution.signals.find((item) => item.type === signalType);
        if (!signal) throw new Error(`fixture interruption signal not found: ${signalType}`);
        interruptionContexts.push({ attention_id: signal.attention_id, ...context });
      }
      const decisions = routeAttentionPresentation({
        signals: resolution.signals, now: evaluation.now,
        ...(evaluation.immediateNotificationsEnabled !== undefined
          ? { immediateNotificationsEnabled: evaluation.immediateNotificationsEnabled } : {}),
        interruptionContexts,
      });
      const channelById = new Map(decisions.map((decision) => [decision.attention_id, decision.channel]));
      const actual = resolution.signals.map((signal) => ({
        type: signal.type, channel: channelById.get(signal.attention_id)!,
      }));

      expect(actual).toEqual(evaluation.expected);
      expect(JSON.stringify({ resolution, decisions })).not.toMatch(/gmail:|imessage:|sha256:|extract_/);
    });
  }
});

test("immediate notification requires explicit enablement and validated near-term consequence", () => {
  const signal = attentionSignal({ impact: "high", urgency: "today" });
  const context = interruptionContext(signal.attention_id, "2026-07-12T11:00:00.000Z", 0.98);

  expect(routeAttentionPresentation({
    signals: [signal], now: new Date("2026-07-12T09:00:00.000Z"),
    interruptionContexts: [context], immediateNotificationsEnabled: false,
  })[0]).toMatchObject({
    channel: "morning_briefing", reason: "high_priority_daily_attention",
  });
  expect(routeAttentionPresentation({
    signals: [signal], now: new Date("2026-07-12T09:00:00.000Z"),
    interruptionContexts: [context], immediateNotificationsEnabled: true,
  })[0]).toMatchObject({
    channel: "immediate_notification", reason: "validated_imminent_consequence",
  });
  expect(routeAttentionPresentation({
    signals: [signal], now: new Date("2026-07-12T09:00:00.000Z"),
    interruptionContexts: [interruptionContext(signal.attention_id, "2026-07-12T15:00:00.000Z", 0.98)],
    immediateNotificationsEnabled: true,
  })[0]?.channel).toBe("morning_briefing");
  expect(routeAttentionPresentation({
    signals: [signal], now: new Date("2026-07-12T09:00:00.000Z"),
    interruptionContexts: [interruptionContext(signal.attention_id, "2026-07-12T11:00:00.000Z", 0.7)],
    immediateNotificationsEnabled: true,
  })[0]?.channel).toBe("morning_briefing");
});

test("router suppresses low-confidence and low-value signals with explicit reasons", () => {
  const lowConfidence = attentionSignal({ attentionId: "attention_low_confidence", confidence: 0.4 });
  const lowValue = attentionSignal({ attentionId: "attention_low_value", impact: "low", urgency: "none" });
  const decisions = routeAttentionPresentation({
    signals: [lowValue, lowConfidence], now: new Date("2026-07-12T09:00:00.000Z"),
  });

  expect(decisions).toEqual([
    expect.objectContaining({
      attention_id: lowConfidence.attention_id, channel: "suppress", reason: "low_confidence",
      policy_version: ATTENTION_PRESENTATION_POLICY_VERSION,
    }),
    expect.objectContaining({
      attention_id: lowValue.attention_id, channel: "suppress", reason: "low_value_no_action",
      policy_version: ATTENTION_PRESENTATION_POLICY_VERSION,
    }),
  ]);
});

test("router is stable across input order and rejects stale or duplicate identities", () => {
  const morning = attentionSignal({ attentionId: "attention_morning", impact: "high", urgency: "today" });
  const review = attentionSignal({ attentionId: "attention_review", impact: "medium", urgency: "soon" });
  const now = new Date("2026-07-12T09:00:00.000Z");
  const first = routeAttentionPresentation({ signals: [review, morning], now });
  const reordered = routeAttentionPresentation({ signals: [morning, review], now });
  expect(reordered).toEqual(first);
  expect(first.map((decision) => decision.channel)).toEqual(["morning_briefing", "review_queue"]);

  expect(() => routeAttentionPresentation({ signals: [morning, morning], now }))
    .toThrow("complete and unique");
  expect(() => routeAttentionPresentation({
    signals: [morning], now,
    interruptionContexts: [interruptionContext("attention_stale", "2026-07-12T10:00:00.000Z", 1)],
  })).toThrow("unknown attention signal");
  expect(() => routeAttentionPresentation({
    signals: [morning], now,
    interruptionContexts: [{
      ...interruptionContext(morning.attention_id, "2026-07-12T10:00:00.000Z", 1),
      content_hash: "invalid",
    }],
  })).toThrow("validation identity is incomplete");
});

function attentionSignal(input: {
  attentionId?: string;
  confidence?: number;
  impact?: AttentionSignal["impact"];
  urgency?: AttentionSignal["urgency"];
} = {}): AttentionSignal {
  return {
    attention_id: input.attentionId ?? "attention_example",
    type: "untracked_user_commitment", title: "Example", summary: "Review the example",
    finding_ids: ["finding_example"], subject_refs: [], owner: "user",
    confidence: input.confidence ?? 0.95,
    impact: input.impact ?? "low", urgency: input.urgency ?? "none", due_date: null,
    explanation: "Fixture signal", ambiguities: [], suggested_interventions: [],
  };
}

function interruptionContext(
  attentionId: string, effectiveAt: string, confidence: number,
): ValidatedInterruptionContext {
  return {
    attention_id: attentionId, consequence: "irreversible_loss", effective_at: effectiveAt,
    confidence, validator: { method: "deterministic", version: "test-v1" },
    content_hash: `sha256:interruption-${attentionId}-${effectiveAt}`,
  };
}
