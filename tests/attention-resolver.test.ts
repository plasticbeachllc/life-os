import { expect, test } from "bun:test";

import { resolveAttention } from "../src/attention/resolver";
import type { DerivedStateRecord } from "../src/db/store";
import type { ActiveFindingProjectionInput } from "../src/findings/store";
import type {
  ValidatedCommunicationContext, ValidatedFindingRelation,
} from "../src/attention/contract";

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
    missing_communication_context: 0,
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

test("validated communication context derives reply attention and a later response relation suppresses it", () => {
  const request = finding(
    "finding_request", "explicit_request", "Confirm whether the revised time works", "user", null,
  );
  const reply = finding(
    "finding_reply", "open_loop", "Confirmed that the revised time works", "user", null,
  );
  const context = communicationContext(request.findingId, {
    direction: "incoming", responseExpectation: "required", responseState: "awaiting_response",
  });
  const pending = resolveAttention({
    now: new Date("2026-07-12T09:00:00.000Z"), activeFindings: [request], tasks: [],
    communicationContexts: [context],
  });

  expect(pending.signals).toEqual([
    expect.objectContaining({
      type: "response_needed", summary: request.statement,
      suggested_interventions: [expect.objectContaining({
        kind: "draft_reply", permission_class: "prepare", readiness: "unsupported",
      })],
    }),
  ]);
  expect(pending.suppressed.missing_communication_context).toBe(0);

  const responded = resolveAttention({
    now: new Date("2026-07-12T09:00:00.000Z"), activeFindings: [request, reply], tasks: [],
    communicationContexts: [context],
    relations: [relation("relation_reply", "responds_to", reply.findingId, request.findingId)],
  });
  expect(responded.signals).toEqual([]);
});

test("only validated incoming required-response context can create response attention", () => {
  const overdue = finding(
    "finding_overdue_response", "explicit_request", "Send confirmation", "user", "2026-07-10",
  );
  const valid = resolveAttention({
    now: new Date("2026-07-12T09:00:00.000Z"), activeFindings: [overdue], tasks: [],
    communicationContexts: [communicationContext(overdue.findingId, {
      direction: "incoming", responseExpectation: "required", responseState: "awaiting_response",
    })],
  });
  expect(valid.signals[0]).toMatchObject({
    type: "response_overdue", impact: "high", urgency: "today",
  });

  for (const context of [
    communicationContext(overdue.findingId, {
      direction: "outgoing", responseExpectation: "required", responseState: "awaiting_response",
    }),
    communicationContext(overdue.findingId, {
      direction: "incoming", responseExpectation: "optional", responseState: "awaiting_response",
    }),
    communicationContext(overdue.findingId, {
      direction: "incoming", responseExpectation: "required", responseState: "responded",
    }),
  ]) {
    expect(resolveAttention({
      now: new Date("2026-07-12T09:00:00.000Z"), activeFindings: [overdue], tasks: [],
      communicationContexts: [context],
    }).signals).toEqual([]);
  }
});

test("validated resolution relations replace risk attention with a reviewable resolution signal", () => {
  const commitment = finding(
    "finding_commitment", "user_commitment", "File the annual report", "user", "2026-07-10",
  );
  const completion = finding(
    "finding_completion", "project_update", "The annual report was filed", "shared", null,
  );
  const resolution = resolveAttention({
    now: new Date("2026-07-12T09:00:00.000Z"),
    activeFindings: [commitment, completion],
    tasks: [task("task_report", "File the annual report", "2026-07-10")],
    relations: [relation(
      "relation_resolution", "resolves", completion.findingId, commitment.findingId,
    )],
  });

  expect(resolution.signals).toEqual([
    expect.objectContaining({
      type: "commitment_resolved", summary: commitment.statement,
      finding_ids: [commitment.findingId, completion.findingId].sort(),
      subject_refs: [{ type: "task", id: "task_report" }],
      suggested_interventions: [
        expect.objectContaining({ kind: "review_resolution", readiness: "ready" }),
        expect.objectContaining({ kind: "complete_task", readiness: "unsupported" }),
      ],
    }),
  ]);
  expect(resolution.signals.some((signal) => signal.type === "commitment_at_risk")).toBe(false);
});

test("semantic compatibility inputs reject stale references and incomplete validation identity", () => {
  const request = finding("finding_request", "explicit_request", "Please reply", "user", null);
  expect(() => resolveAttention({
    now: new Date("2026-07-12T09:00:00.000Z"), activeFindings: [request], tasks: [],
    communicationContexts: [communicationContext("finding_missing", {
      direction: "incoming", responseExpectation: "required", responseState: "awaiting_response",
    })],
  })).toThrow("non-active finding");
  expect(() => resolveAttention({
    now: new Date("2026-07-12T09:00:00.000Z"), activeFindings: [request], tasks: [],
    communicationContexts: [{
      ...communicationContext(request.findingId, {
        direction: "incoming", responseExpectation: "required", responseState: "awaiting_response",
      }),
      content_hash: "not-a-hash",
    }],
  })).toThrow("validation identity is incomplete");
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

function communicationContext(findingId: string, input: {
  direction: ValidatedCommunicationContext["direction"];
  responseExpectation: ValidatedCommunicationContext["response_expectation"];
  responseState: ValidatedCommunicationContext["response_state"];
}): ValidatedCommunicationContext {
  return {
    finding_id: findingId, direction: input.direction,
    response_expectation: input.responseExpectation, response_state: input.responseState,
    validator: { method: "deterministic", version: "test-v1" },
    content_hash: `sha256:context-${findingId}-${input.direction}-${input.responseState}`,
  };
}

function relation(
  relationId: string,
  kind: ValidatedFindingRelation["kind"],
  fromFindingId: string,
  toFindingId: string,
): ValidatedFindingRelation {
  return {
    relation_id: relationId, kind,
    from_finding_id: fromFindingId, to_finding_id: toFindingId,
    confidence: 0.95,
    validator: { method: "deterministic", version: "test-v1" },
    content_hash: `sha256:${relationId}`,
  };
}
