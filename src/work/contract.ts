export const workErrorCategories = [
  "provider_transient", "rate_limited", "source_unavailable", "validation",
  "stale_source", "internal", "retry_exhausted",
] as const;

export type WorkErrorCategory = typeof workErrorCategories[number];
export type WorkState = "pending" | "leased" | "completed" | "stale" | "failed";
export type WorkWorkflow = "gmail_extraction" | "imessage_extraction";
export type WorkSubjectType = "gmail_message" | "imessage_conversation";

export interface WorkItem {
  workId: string;
  workflow: WorkWorkflow;
  subjectType: WorkSubjectType;
  subjectSourceId: string;
  subjectId: string;
  anchorId: string;
  sourceHash: string;
  containerHash: string;
  reason: "source_delta" | "contract_refresh";
  invalidationKey: string;
  state: WorkState;
  priority: number;
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  availableAt: string;
  errorCategory?: WorkErrorCategory;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface EnqueueWorkInput {
  workflow: WorkWorkflow;
  subjectType: WorkSubjectType;
  subjectSourceId: string;
  subjectId: string;
  anchorId: string;
  sourceHash: string;
  containerHash: string;
  reason: WorkItem["reason"];
  now: string;
  priority?: number;
  maxAttempts?: number;
  contractIdentity?: string;
}

export interface WorkStatus {
  total: number;
  byState: Record<WorkState, number>;
  byWorkflow: Record<WorkWorkflow, number>;
  oldestPendingAgeSeconds: number | null;
}
