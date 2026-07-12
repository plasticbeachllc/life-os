import type { ContextBudget } from "./budget";
import { validateBudget } from "./budget";
import { sha256Value } from "../util/hashing";
import { newId } from "../util/ids";

export type RetrievalLevel = 0 | 1 | 2 | 3;
export type ContextCategory = "source" | "entity_state" | "recent_change" | "policy";

export interface ContextCandidate {
  id: string;
  category: ContextCategory;
  retrievalLevel: RetrievalLevel;
  content: unknown;
  tokenEstimate: number;
  relevance: number;
  impact?: number;
  recency?: number;
  deduplicationKey?: string;
  sourceRefs: string[];
}

export interface ContextManifest {
  manifestId: string;
  includedItems: ContextCandidate[];
  omittedItems: Array<ContextCandidate & { omissionReason: string }>;
  tokenBudget: ContextBudget;
  retrievalLevels: RetrievalLevel[];
  rankingVersion: string;
  contextHash: string;
  createdAt: string;
}

const categoryBudgetKey = {
  source: "sourceTokens",
  entity_state: "entityStateTokens",
  recent_change: "recentChangeTokens",
  policy: "policyTokens",
} as const;

export function buildContext(candidates: ContextCandidate[], budget: ContextBudget): ContextManifest {
  validateBudget(budget);
  const rankingVersion = "decision-value-v1";
  const ranked = [...candidates].sort((left, right) => score(right) - score(left) || left.id.localeCompare(right.id));
  const usedByCategory: Record<ContextCategory, number> = {
    source: 0, entity_state: 0, recent_change: 0, policy: 0,
  };
  const seen = new Set<string>();
  const includedItems: ContextCandidate[] = [];
  const omittedItems: Array<ContextCandidate & { omissionReason: string }> = [];

  for (const item of ranked) {
    const deduplicationKey = item.deduplicationKey ?? sha256Value(item.content);
    if (seen.has(deduplicationKey)) {
      omittedItems.push({ ...item, omissionReason: "duplicate" });
      continue;
    }
    const categoryLimit = budget[categoryBudgetKey[item.category]];
    if (usedByCategory[item.category] + item.tokenEstimate > categoryLimit) {
      omittedItems.push({ ...item, omissionReason: "category_budget" });
      continue;
    }
    seen.add(deduplicationKey);
    usedByCategory[item.category] += item.tokenEstimate;
    includedItems.push(item);
  }

  const retrievalLevels = [...new Set(includedItems.map((item) => item.retrievalLevel))].sort() as RetrievalLevel[];
  const contextHash = sha256Value(includedItems.map(({ id, content, retrievalLevel, sourceRefs }) => ({
    id, content, retrievalLevel, sourceRefs,
  })));
  return {
    manifestId: newId("manifest"), includedItems, omittedItems, tokenBudget: budget,
    retrievalLevels, rankingVersion, contextHash, createdAt: new Date().toISOString(),
  };
}

function score(item: ContextCandidate): number {
  return item.relevance * 0.55 + (item.impact ?? 0) * 0.3 + (item.recency ?? 0) * 0.15;
}
