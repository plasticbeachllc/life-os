import type { ContextBudget } from "./budget";

export type ContextPurpose = "extract" | "resolve" | "summarize" | "prioritize" | "verify" | "plan";

export interface ContextSourceIdentity {
  provider: "obsidian" | "gmail" | "calendar" | "imessage" | "telegram";
  sourceId: string;
  artifactId: string;
  versionHash: string;
  containerId?: string;
  containerHash?: string;
}

export interface ContextRequest {
  workflow: string;
  trigger: {
    type: "source_delta" | "user_query" | "scheduled_review" | "proposal";
    subjectId: string;
    sourceIdentities: ContextSourceIdentity[];
  };
  purpose: ContextPurpose;
  budget: ContextBudget;
}
