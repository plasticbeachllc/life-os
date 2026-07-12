import type { OperationalStore } from "../db/store";

export interface EfficiencyReport {
  modelCalls: number;
  totalModelTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCost: number;
  cacheHitRate: number | null;
  usefulBriefingItems: number;
  rejectedBriefingItems: number;
  feedbackCoverage: number;
  tokensPerUsefulBriefingItem: number | null;
  usefulOutputsPerThousandTokens: number | null;
}

export function efficiencyReport(store: OperationalStore): EfficiencyReport {
  const raw = store.efficiencyMetrics();
  const totalModelTokens = raw.inputTokens + raw.outputTokens;
  return {
    modelCalls: raw.modelCalls, totalModelTokens, inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens, cachedTokens: raw.cachedTokens,
    estimatedCost: raw.estimatedCost,
    cacheHitRate: raw.modelCalls > 0 ? raw.cacheHits / raw.modelCalls : null,
    usefulBriefingItems: raw.usefulBriefingItems,
    rejectedBriefingItems: raw.rejectedBriefingItems,
    feedbackCoverage: raw.feedbackItems,
    tokensPerUsefulBriefingItem: raw.usefulBriefingItems > 0 ? totalModelTokens / raw.usefulBriefingItems : null,
    usefulOutputsPerThousandTokens: totalModelTokens > 0 ? raw.usefulBriefingItems * 1000 / totalModelTokens : null,
  };
}
