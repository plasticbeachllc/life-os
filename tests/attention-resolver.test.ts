import { expect, test } from "bun:test";

import { resolveAttention } from "../src/attention/resolver";
import type { DerivedStateRecord } from "../src/db/store";
import type { ActiveFindingProjectionInput } from "../src/findings/store";

test("attention resolver derives bounded signals and suppresses already tracked commitments", () => {
  const resolution = resolveAttention({
    now: new Date("2026-07-12T09:00:00.000Z"),
    activeFindings: [
      finding("finding_untracked", "user_commitment", "Submit renewal form", "user", "2026-07-20"),
      finding("finding_waiting", "other_commitment", "Send the signed agreement", "other", null),
      finding("finding_overdue", "user_commitment", "Pay the registration fee", "user", "2026-07-10"),
      finding("finding_deadline", "user_commitment", "Prepare the board packet", "user", "2026-07-15"),
      finding("finding_duplicate_a", "user_commitment", "Book the venue!", "user", null),
      finding("finding_duplicate_b", "user_commitment", "book the venue", "user", null),
      finding("finding_tracked", "user_commitment", "Send the agenda", "user", "2026-07-18"),
      { ...finding("finding_low", "user_commitment", "Consider a tentative idea", "user", null), confidence: 0.4 },
      finding("finding_decision", "decision", "Choose the annual plan", "shared", null),
    ],
    tasks: [
      task("task_packet", "Prepare the board packet", null),
      task("task_agenda", "Send the agenda", "2026-07-18"),
    ],
  });

  expect(resolution.signals.map((signal) => signal.type).sort()).toEqual([
    "commitment_at_risk",
    "deadline_not_tracked",
    "duplicate_commitment",
    "untracked_user_commitment",
    "waiting_on_other",
  ]);
  expect(resolution.signals[0]?.type).toBe("commitment_at_risk");
  expect(resolution.suppressed).toEqual({
    tracked_commitments: 1,
    low_confidence_findings: 1,
    unsupported_findings: 1,
  });

  const untracked = resolution.signals.find((signal) => signal.type === "untracked_user_commitment")!;
  expect(untracked.suggested_interventions).toContainEqual(expect.objectContaining({
    kind: "create_task", permission_class: "yellow", readiness: "ready",
  }));
  const waiting = resolution.signals.find((signal) => signal.type === "waiting_on_other")!;
  expect(waiting.suggested_interventions).toContainEqual(expect.objectContaining({
    kind: "draft_follow_up", permission_class: "prepare", readiness: "unsupported",
  }));
  const deadline = resolution.signals.find((signal) => signal.type === "deadline_not_tracked")!;
  expect(deadline.subject_refs).toEqual([{ type: "task", id: "task_packet" }]);

  const serialized = JSON.stringify(resolution);
  expect(serialized).not.toContain("sha256:");
  expect(serialized).not.toContain("gmail:");
  expect(serialized).not.toContain("status-event");
});

test("ambiguous commitments may surface but do not advertise task creation as ready", () => {
  const ambiguous = finding(
    "finding_ambiguous", "user_commitment", "Prepare the requested materials", "user", null,
  );
  ambiguous.ambiguities = ["The requested format is unclear."];
  const resolution = resolveAttention({
    now: new Date("2026-07-12T09:00:00.000Z"), activeFindings: [ambiguous], tasks: [],
  });

  expect(resolution.signals[0]).toMatchObject({
    type: "untracked_user_commitment",
    ambiguities: ["The requested format is unclear."],
    suggested_interventions: [{ kind: "create_task", readiness: "needs_clarification" }],
  });
});

test("attention resolution is stable across input order and avoids fuzzy semantic matching", () => {
  const findings = [
    finding("finding_first", "user_commitment", "Send final proposal", "user", null),
    finding("finding_second", "other_commitment", "Review final proposal", "other", null),
  ];
  const input = {
    now: new Date("2026-07-12T09:00:00.000Z"),
    tasks: [task("task_review", "Review proposal", null)],
  };
  const first = resolveAttention({ ...input, activeFindings: findings });
  const reordered = resolveAttention({ ...input, activeFindings: [...findings].reverse() });

  expect(reordered).toEqual(first);
  expect(first.signals).toHaveLength(2);
  expect(first.signals.find((signal) => signal.finding_ids.includes("finding_second"))?.type)
    .toBe("waiting_on_other");
});

function finding(
  findingId: string,
  kind: string,
  statement: string,
  owner: string,
  dueDate: string | null,
): ActiveFindingProjectionInput {
  return {
    findingId, kind, statement, owner, dueDate, confidence: 0.9, ambiguities: [],
    contentHash: `sha256:${findingId}`, statusEventId: `status-event-${findingId}`,
    statusChangedAt: "2026-07-12T08:00:00.000Z",
  };
}

function task(taskId: string, description: string, dueDate: string | null): DerivedStateRecord {
  return {
    stateId: `state_${taskId}`, stateType: "task_state", entityId: taskId, stateVersion: 1,
    content: { task_id: taskId, description, due_date: dueDate, status: "open" },
    sourceHashes: [`sha256:${taskId}`], generationMethod: "test",
    createdAt: "2026-07-12T08:00:00.000Z",
  };
}
