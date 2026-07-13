import type {
  AttentionSignalType, ValidatedCommunicationContext, ValidatedFindingRelation,
} from "../../src/attention/contract";
import type { PresentationChannel, ValidatedInterruptionContext } from "../../src/attention/presentation";
import type { DerivedStateRecord } from "../../src/db/store";
import type { ActiveFindingProjectionInput } from "../../src/findings/store";

export interface AttentionEvaluationCase {
  name: string;
  now: Date;
  findings: ActiveFindingProjectionInput[];
  tasks: DerivedStateRecord[];
  communicationContexts?: ValidatedCommunicationContext[];
  relations?: ValidatedFindingRelation[];
  immediateNotificationsEnabled?: boolean;
  interruption?: Omit<ValidatedInterruptionContext, "attention_id"> & { signalType: AttentionSignalType };
  expected: Array<{ type: AttentionSignalType; channel: PresentationChannel }>;
}

const now = new Date("2026-07-12T09:00:00.000Z");

export const attentionEvaluationCorpus: AttentionEvaluationCase[] = [
  {
    name: "tracked commitment stays silent",
    now,
    findings: [finding("tracked", "user_commitment", "Prepare the planning notes", "user", "2026-07-15")],
    tasks: [task("planning", "Prepare the planning notes", "2026-07-15")],
    expected: [],
  },
  {
    name: "untracked commitment enters review queue",
    now,
    findings: [finding("untracked", "user_commitment", "Prepare the planning notes", "user", "2026-07-15")],
    tasks: [],
    expected: [{ type: "untracked_user_commitment", channel: "review_queue" }],
  },
  {
    name: "overdue commitment enters morning briefing",
    now,
    findings: [finding("overdue", "user_commitment", "Submit the renewal form", "user", "2026-07-10")],
    tasks: [],
    expected: [{ type: "commitment_at_risk", channel: "morning_briefing" }],
  },
  {
    name: "required incoming response enters review queue",
    now,
    findings: [finding("reply", "explicit_request", "Confirm whether the proposed time works", "user", null)],
    tasks: [],
    communicationContexts: [communication("reply", "incoming", "required", "awaiting_response")],
    expected: [{ type: "response_needed", channel: "review_queue" }],
  },
  {
    name: "overdue response enters morning briefing",
    now,
    findings: [finding("reply_overdue", "explicit_request", "Send confirmation", "user", "2026-07-10")],
    tasks: [],
    communicationContexts: [communication("reply_overdue", "incoming", "required", "awaiting_response")],
    expected: [{ type: "response_overdue", channel: "morning_briefing" }],
  },
  {
    name: "validated response closes reply attention",
    now,
    findings: [
      finding("request", "explicit_request", "Confirm the proposed time", "user", null),
      finding("answer", "open_loop", "Confirmed the proposed time", "user", null),
    ],
    tasks: [],
    communicationContexts: [communication("request", "incoming", "required", "awaiting_response")],
    relations: [relation("answered", "responds_to", "answer", "request")],
    expected: [],
  },
  {
    name: "incoming resolution closes an earlier request",
    now,
    findings: [
      finding("resolved_request", "explicit_request", "Choose a meeting time", "user", null),
      finding("acceptance", "acceptance", "The proposed meeting time works", "shared", null),
    ],
    tasks: [],
    communicationContexts: [communication(
      "resolved_request", "incoming", "required", "awaiting_response",
    )],
    relations: [relation("request_resolved", "resolves", "acceptance", "resolved_request")],
    expected: [],
  },
  {
    name: "repeated equivalent requests enter the review queue once",
    now,
    findings: [
      finding("repeated_a", "explicit_request", "Choose an available meeting time", "user", null),
      finding("repeated_b", "explicit_request", "choose an available meeting time!", "user", null),
    ],
    tasks: [],
    communicationContexts: [
      communication("repeated_a", "incoming", "required", "awaiting_response"),
      communication("repeated_b", "incoming", "required", "awaiting_response"),
    ],
    expected: [{ type: "response_needed", channel: "review_queue" }],
  },
  {
    name: "validated completion enters resolution review",
    now,
    findings: [
      finding("commitment", "user_commitment", "File the annual report", "user", "2026-07-10"),
      finding("completion", "project_update", "The annual report was filed", "shared", null),
    ],
    tasks: [task("report", "File the annual report", "2026-07-10")],
    relations: [relation("completed", "resolves", "completion", "commitment")],
    expected: [{ type: "commitment_resolved", channel: "review_queue" }],
  },
  {
    name: "duplicate commitment enters review queue once",
    now,
    findings: [
      finding("duplicate_a", "user_commitment", "Book the venue", "user", null),
      finding("duplicate_b", "user_commitment", "Book the venue!", "user", null),
    ],
    tasks: [],
    expected: [{ type: "duplicate_commitment", channel: "review_queue" }],
  },
  {
    name: "low confidence commitment stays silent",
    now,
    findings: [{
      ...finding("tentative", "user_commitment", "Consider a tentative option", "user", null),
      confidence: 0.4,
    }],
    tasks: [],
    expected: [],
  },
  {
    name: "ambiguous commitment enters review but is not action-ready",
    now,
    findings: [{
      ...finding("ambiguous", "user_commitment", "Prepare the requested materials", "user", null),
      ambiguities: ["The requested format is unclear."],
    }],
    tasks: [],
    expected: [{ type: "untracked_user_commitment", channel: "review_queue" }],
  },
  {
    name: "validated imminent irreversible loss can interrupt when explicitly enabled",
    now,
    findings: [finding("urgent_reply", "explicit_request", "Confirm before the reservation expires", "user", "2026-07-10")],
    tasks: [],
    communicationContexts: [communication("urgent_reply", "incoming", "required", "awaiting_response")],
    immediateNotificationsEnabled: true,
    interruption: {
      signalType: "response_overdue", consequence: "irreversible_loss",
      effective_at: "2026-07-12T11:00:00.000Z", confidence: 0.98,
      validator: { method: "deterministic", version: "fixture-v1" },
      content_hash: "sha256:urgent-reservation-expiry",
    },
    expected: [{ type: "response_overdue", channel: "immediate_notification" }],
  },
];

function finding(
  suffix: string, kind: string, statement: string, owner: string, dueDate: string | null,
): ActiveFindingProjectionInput {
  const findingId = `finding_${suffix}`;
  return {
    findingId, kind, statement, owner, dueDate, confidence: 0.9, ambiguities: [],
    contentHash: `sha256:${suffix}`, statusEventId: `event_${suffix}`,
    statusChangedAt: "2026-07-12T08:00:00.000Z",
  };
}

function task(suffix: string, description: string, dueDate: string | null): DerivedStateRecord {
  const taskId = `task_${suffix}`;
  return {
    stateId: `state_${suffix}`, stateType: "task_state", entityId: taskId, stateVersion: 1,
    content: { task_id: taskId, description, due_date: dueDate, status: "open" },
    sourceHashes: [`sha256:task-${suffix}`], generationMethod: "fixture",
    createdAt: "2026-07-12T08:00:00.000Z",
  };
}

function communication(
  findingSuffix: string,
  direction: ValidatedCommunicationContext["direction"],
  expectation: ValidatedCommunicationContext["response_expectation"],
  state: ValidatedCommunicationContext["response_state"],
): ValidatedCommunicationContext {
  return {
    finding_id: `finding_${findingSuffix}`, direction,
    response_expectation: expectation, response_state: state,
    validator: { method: "deterministic", version: "fixture-v1" },
    content_hash: `sha256:communication-${findingSuffix}-${direction}-${state}`,
  };
}

function relation(
  suffix: string, kind: ValidatedFindingRelation["kind"],
  fromSuffix: string, toSuffix: string,
): ValidatedFindingRelation {
  return {
    relation_id: `relation_${suffix}`, kind,
    from_finding_id: `finding_${fromSuffix}`, to_finding_id: `finding_${toSuffix}`,
    confidence: 0.95,
    validator: { method: "deterministic", version: "fixture-v1" },
    content_hash: `sha256:relation-${suffix}`,
  };
}
