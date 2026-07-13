import { expect, test } from "bun:test";

import {
  compileAttentionReview, MAX_ATTENTION_REVIEW_ITEMS,
} from "../src/attention/review";
import {
  routeAttentionPresentation, type ValidatedInterruptionContext,
} from "../src/attention/presentation";
import { resolveAttention } from "../src/attention/resolver";
import type { AttentionSignal } from "../src/attention/contract";
import type { DerivedStateRecord } from "../src/db/store";
import { attentionEvaluationCorpus } from "./fixtures/attention-evaluation";

test("attention review compiles only bounded review-queue items from the evaluation corpus", () => {
  const review = compileAttentionReview(corpusState());

  expect(review.counts).toMatchObject({
    byChannel: {
      suppress: 0, review_queue: 6, morning_briefing: 2, immediate_notification: 1,
    },
    reviewQueue: 6, returned: 6, omitted: 0,
  });
  expect(review.items.map((item) => item.type).sort()).toEqual([
    "commitment_resolved", "duplicate_commitment", "response_needed", "response_needed",
    "untracked_user_commitment", "untracked_user_commitment",
  ]);
  expect(review.items.every((item) => item.presentation.channel === "review_queue")).toBe(true);
  expect(review.items.some((item) => item.type === "commitment_at_risk")).toBe(false);
  expect(review.items.some((item) => item.type === "response_overdue")).toBe(false);

  const serialized = JSON.stringify(review);
  expect(serialized).not.toMatch(/sha256:|gmail:|imessage:|extract_|raw source excerpt|provider-message/);
});

test("attention review is bounded, priority ordered, and reports omissions", () => {
  const signals = Array.from({ length: MAX_ATTENTION_REVIEW_ITEMS + 1 }, (_, index) =>
    signal(`attention_${String(index).padStart(3, "0")}`, {
      impact: index === MAX_ATTENTION_REVIEW_ITEMS ? "high" : "medium",
      urgency: index === MAX_ATTENTION_REVIEW_ITEMS ? "today" : "soon",
      title: "T".repeat(180), summary: "S".repeat(300),
    }));
  const state = attentionState(signals, signals.map((item) => ({
    attention_id: item.attention_id, channel: "review_queue", reason: "reviewable_intervention",
    explanation: "A bounded review is useful.", policy_version: "attention-presentation-v1",
  })));
  const review = compileAttentionReview(state);

  expect(review.counts).toMatchObject({ reviewQueue: 51, returned: 50, omitted: 1 });
  expect(review.items[0]?.attentionId).toBe("attention_050");
  expect(review.items[0]?.title.length).toBeLessThanOrEqual(120);
  expect(review.items[0]?.summary.length).toBeLessThanOrEqual(240);
});

test("attention review rejects incomplete, stale, duplicated, and malformed projections", () => {
  const validSignal = signal("attention_valid");
  const validDecision = {
    attention_id: validSignal.attention_id, channel: "review_queue",
    reason: "reviewable_intervention", explanation: "Review this item.",
    policy_version: "attention-presentation-v1",
  };
  expect(() => compileAttentionReview(attentionState([validSignal], [])))
    .toThrow("presentation is incomplete");
  expect(() => compileAttentionReview(attentionState([validSignal, validSignal], [validDecision])))
    .toThrow("identity is duplicated");
  expect(() => compileAttentionReview(attentionState([validSignal], [{
    ...validDecision, policy_version: "attention-presentation-old",
  }]))) .toThrow("policy is stale");
  expect(() => compileAttentionReview(attentionState([{ ...validSignal, finding_ids: ["gmail:private"] }], [validDecision])))
    .toThrow("finding ID is invalid");
});

function corpusState(): DerivedStateRecord {
  const signals: AttentionSignal[] = [];
  const decisions: unknown[] = [];
  for (const evaluation of attentionEvaluationCorpus) {
    const resolution = resolveAttention({
      activeFindings: evaluation.findings, tasks: evaluation.tasks, now: evaluation.now,
      ...(evaluation.communicationContexts
        ? { communicationContexts: evaluation.communicationContexts } : {}),
      ...(evaluation.relations ? { relations: evaluation.relations } : {}),
    });
    const interruptionContexts: ValidatedInterruptionContext[] = [];
    if (evaluation.interruption) {
      const { signalType, ...context } = evaluation.interruption;
      const selected = resolution.signals.find((item) => item.type === signalType)!;
      interruptionContexts.push({ attention_id: selected.attention_id, ...context });
    }
    signals.push(...resolution.signals.map((item) => ({
      ...item,
      source_hash: "sha256:must-not-escape",
      provider_message_id: "provider-message-must-not-escape",
      raw_excerpt: "raw source excerpt must not escape",
    })));
    decisions.push(...routeAttentionPresentation({
      signals: resolution.signals, now: evaluation.now,
      ...(evaluation.immediateNotificationsEnabled !== undefined
        ? { immediateNotificationsEnabled: evaluation.immediateNotificationsEnabled } : {}),
      interruptionContexts,
    }));
  }
  return attentionState(signals, decisions);
}

function attentionState(
  signals: Array<AttentionSignal | Record<string, unknown>>,
  presentation: unknown[],
): DerivedStateRecord {
  return {
    stateId: "state_attention_review", stateType: "finding_attention_state", stateVersion: 4,
    content: { as_of: "2026-07-12T09:00:00.000Z", signals, presentation },
    sourceHashes: ["sha256:private-state-hash"], generationMethod: "fixture",
    createdAt: "2026-07-12T09:00:00.000Z",
  };
}

function signal(attentionId: string, overrides: Partial<AttentionSignal> = {}): AttentionSignal {
  return {
    attention_id: attentionId, type: "untracked_user_commitment",
    title: "Commitment is not tracked", summary: "Prepare the planning notes",
    finding_ids: [`finding_${attentionId.replace(/^attention_/, "")}`], subject_refs: [],
    owner: "user", confidence: 0.95, impact: "medium", urgency: "soon", due_date: null,
    explanation: "No matching canonical task exists.", ambiguities: [],
    suggested_interventions: [{
      kind: "create_task", rationale: "Track the commitment.",
      expected_benefit: "Include it in planning.", consequence_of_delay: null,
      permission_class: "yellow", readiness: "ready", reversible: true,
    }],
    ...overrides,
  };
}
