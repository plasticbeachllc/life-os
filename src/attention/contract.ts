export const attentionSignalTypes = [
  "untracked_user_commitment",
  "waiting_on_other",
  "commitment_at_risk",
  "deadline_not_tracked",
  "duplicate_commitment",
  "response_needed",
  "response_overdue",
  "commitment_resolved",
] as const;

export type AttentionSignalType = typeof attentionSignalTypes[number];

export const interventionKinds = [
  "create_task",
  "update_task_date",
  "draft_follow_up",
  "draft_reply",
  "review_duplicates",
  "review_resolution",
  "complete_task",
] as const;

export type InterventionKind = typeof interventionKinds[number];

export interface AttentionSubjectRef {
  type: "task";
  id: string;
}

export interface ValidatedCommunicationContext {
  finding_id: string;
  direction: "incoming" | "outgoing" | "system" | "unknown";
  response_expectation: "required" | "optional" | "none" | "unknown";
  response_state: "awaiting_response" | "responded" | "resolved" | "unknown";
  validator: { method: "deterministic" | "validated_reasoning"; version: string };
  content_hash: string;
}

export interface ValidatedFindingRelation {
  relation_id: string;
  kind: "responds_to" | "resolves" | "supersedes";
  from_finding_id: string;
  to_finding_id: string;
  confidence: number;
  validator: { method: "deterministic" | "validated_reasoning"; version: string };
  content_hash: string;
}

export interface SuggestedIntervention {
  kind: InterventionKind;
  rationale: string;
  expected_benefit: string;
  consequence_of_delay: string | null;
  permission_class: "read" | "prepare" | "yellow";
  readiness: "ready" | "needs_clarification" | "unsupported";
  reversible: boolean;
}

export interface AttentionSignal {
  attention_id: string;
  type: AttentionSignalType;
  title: string;
  summary: string;
  finding_ids: string[];
  subject_refs: AttentionSubjectRef[];
  owner: "user" | "other" | "shared" | "unknown";
  confidence: number;
  impact: "low" | "medium" | "high";
  urgency: "none" | "soon" | "today";
  due_date: string | null;
  explanation: string;
  ambiguities: string[];
  suggested_interventions: SuggestedIntervention[];
}
