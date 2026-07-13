export const attentionSignalTypes = [
  "untracked_user_commitment",
  "waiting_on_other",
  "commitment_at_risk",
  "deadline_not_tracked",
  "duplicate_commitment",
] as const;

export type AttentionSignalType = typeof attentionSignalTypes[number];

export const interventionKinds = [
  "create_task",
  "update_task_date",
  "draft_follow_up",
  "review_duplicates",
] as const;

export type InterventionKind = typeof interventionKinds[number];

export interface AttentionSubjectRef {
  type: "task";
  id: string;
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
