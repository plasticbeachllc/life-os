export const semanticFindingKinds = [
  "explicit_request", "user_commitment", "other_commitment", "decision",
  "cancellation", "reschedule", "acceptance", "refusal", "supersession",
  "date", "relationship_update", "project_update", "open_loop",
] as const;

export const semanticFindingOwners = ["user", "other", "shared", "unknown"] as const;

export type SemanticFindingKind = typeof semanticFindingKinds[number];
export type SemanticFindingOwner = typeof semanticFindingOwners[number];
export type FindingSourceType = "gmail_extraction" | "imessage_extraction";
export type FindingStatus = "active" | "dismissed" | "superseded" | "converted";

export interface ExtractionRecordForProjection {
  sourceType: FindingSourceType;
  extractionId: string;
  callId: string;
  output: Record<string, unknown>;
  createdAt: string;
}

export interface SemanticFinding {
  findingId: string;
  sourceType: FindingSourceType;
  sourceExtractionId: string;
  sourceItemIndex: number;
  reasoningCallId: string;
  kind: SemanticFindingKind;
  statement: string;
  owner: SemanticFindingOwner;
  dueDate: string | null;
  confidence: number;
  ambiguities: string[];
  evidenceIds: string[];
  contentHash: string;
  createdAt: string;
}
