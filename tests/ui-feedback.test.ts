import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";
import { attentionSubjectUiId, parseUiFeedback, recordUiFeedback } from "../src/ui/feedback";

test("UI feedback accepts only opaque subjects and domain-specific outcomes", () => {
  expect(parseUiFeedback({
    subjectKind: "finding", subjectUiId: "ui_0123456789abcdefabcd", outcome: "useful",
  })).toEqual({ subjectKind: "finding", subjectUiId: "ui_0123456789abcdefabcd", outcome: "useful" });
  expect(() => parseUiFeedback({
    subjectKind: "finding", subjectUiId: "provider-message-id", outcome: "useful",
  })).toThrow("invalid feedback");
  expect(() => parseUiFeedback({
    subjectKind: "proposal", subjectUiId: "ui_0123456789abcdefabcd", outcome: "useful",
  })).toThrow("proposal feedback outcome");
  expect(parseUiFeedback({
    subjectKind: "attention", subjectUiId: "ui_0123456789abcdefabcd", outcome: "already_handled",
  })).toEqual({ subjectKind: "attention", subjectUiId: "ui_0123456789abcdefabcd", outcome: "already_handled" });
  expect(() => parseUiFeedback({
    subjectKind: "attention", subjectUiId: "ui_0123456789abcdefabcd", outcome: "not_useful",
  })).toThrow("attention feedback outcome");
});

test("attention UI feedback binds an opaque subject to the exact current presentation", () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-attention-feedback-")), "store.db"));
  store.migrate();
  store.saveDerivedState(attentionState());
  const subjectUiId = attentionSubjectUiId({
    attentionId: "attention_review_me", presentationChannel: "review_queue",
    presentationReason: "reviewable_intervention", policyVersion: "attention-presentation-v1",
  });
  const value = { subjectKind: "attention", subjectUiId, outcome: "already_handled" };

  const first = recordUiFeedback({ store, value, now: new Date("2026-07-12T10:00:00.000Z") });
  const replay = recordUiFeedback({ store, value, now: new Date("2026-07-12T10:01:00.000Z") });

  expect(replay).toBe(first);
  expect(store.countRows("attention_feedback")).toBe(1);
  expect(store.attentionFeedbackMetrics()).toEqual([{
    signalType: "untracked_user_commitment", presentationChannel: "review_queue",
    interventionLevel: 4, total: 1, useful: 0, negative: 1,
  }]);
  const db = store.open();
  try {
    const serialized = JSON.stringify(db.query("SELECT * FROM attention_feedback").all());
    expect(serialized).toContain("attention_review_me");
    expect(serialized).toContain("already_handled");
    expect(serialized).toContain("review_queue");
    expect(serialized).not.toMatch(/finding_private|sha256:|provider|source excerpt/);
  } finally { db.close(); }

  store.saveDerivedState(attentionState(
    "state_rerouted", "morning_briefing", "high_priority_daily_attention",
  ));
  expect(() => recordUiFeedback({ store, value })).toThrow("not currently reviewable");
  expect(() => recordUiFeedback({ store, value: {
    ...value, subjectUiId: "ui_ffffffffffffffffffff",
  } })).toThrow("not currently reviewable");
});

function attentionState(
  stateId = "state_private", channel = "review_queue", reason = "reviewable_intervention",
) {
  return {
    stateId, stateType: "finding_attention_state", stateVersion: 4,
    content: {
      as_of: "2026-07-12T09:00:00.000Z",
      signals: [{
        attention_id: "attention_review_me", type: "untracked_user_commitment",
        title: "Commitment is not tracked", summary: "Prepare the planning notes",
        finding_ids: ["finding_private"], subject_refs: [], owner: "user",
        confidence: 0.95, impact: "medium", urgency: "soon", due_date: null,
        explanation: "No matching canonical task exists.", ambiguities: [],
        suggested_interventions: [{
          kind: "create_task", rationale: "Track the commitment.",
          expected_benefit: "Include it in planning.", consequence_of_delay: null,
          permission_class: "yellow", readiness: "ready", reversible: true,
        }],
      }],
      presentation: [{
        attention_id: "attention_review_me", channel,
        reason, explanation: "A bounded review is useful.",
        policy_version: "attention-presentation-v1",
      }],
    },
    sourceHashes: ["sha256:private"], generationMethod: "test",
    createdAt: "2026-07-12T09:00:00.000Z",
  };
}

test("UI feedback persists no provider or source payload", () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-feedback-")), "store.db"));
  store.migrate();
  recordUiFeedback({ store, value: {
    subjectKind: "proposal", subjectUiId: "ui_0123456789abcdefabcd", outcome: "accepted",
  } });
  const db = store.open();
  try {
    const serialized = JSON.stringify(db.query("SELECT * FROM ui_feedback").all());
    expect(serialized).toContain("accepted");
    expect(serialized).not.toContain("provider");
    expect(serialized).not.toContain("sha256:");
  } finally { db.close(); }
});
