import type { ContextBudget } from "./budget";
import type { ContextCandidate, ContextManifest, RetrievalLevel } from "./builder";

export type LiveContextManifest = ContextManifest;

export interface PersistableContextManifest {
  manifestId: string;
  includedItems: unknown[];
  omittedItems: unknown[];
  tokenBudget: ContextBudget;
  retrievalLevels: RetrievalLevel[];
  rankingVersion: string;
  contextHash: string;
  createdAt: string;
}

export function persistableContextManifest(
  manifest: LiveContextManifest,
  sanitize: (items: ContextCandidate[]) => unknown[],
): PersistableContextManifest {
  return {
    manifestId: manifest.manifestId,
    includedItems: sanitize(manifest.includedItems),
    omittedItems: sanitize(manifest.omittedItems),
    tokenBudget: manifest.tokenBudget,
    retrievalLevels: manifest.retrievalLevels,
    rankingVersion: manifest.rankingVersion,
    contextHash: manifest.contextHash,
    createdAt: manifest.createdAt,
  };
}
