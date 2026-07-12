import { sha256Value } from "../util/hashing";

export interface ModelCacheKeyInput {
  workflow: string;
  promptVersion: string;
  model: string;
  sourceHash: string;
  contextHash: string;
  schemaVersion: string;
  policyVersion: string;
}

export function modelCacheKey(input: ModelCacheKeyInput): string {
  return `cache_${sha256Value(input)}`;
}
