import type { OperationalStore } from "../db/store";
import { sha256Text } from "../util/hashing";
import { newId } from "../util/ids";

export interface TrackedChange {
  changed: boolean;
  contentHash: string;
  previousHash?: string;
  relevantSectionHashes: Record<string, string>;
}

export class ChangeTracker {
  constructor(private readonly store: OperationalStore) {}

  track(input: {
    sourceType: string;
    sourceId: string;
    content: string;
    relevantSections?: Record<string, string>;
  }): TrackedChange {
    const contentHash = sha256Text(input.content);
    const previousHash = this.store.latestSourceHash(input.sourceType, input.sourceId);
    const relevantSectionHashes = Object.fromEntries(
      Object.entries(input.relevantSections ?? {}).map(([name, content]) => [name, sha256Text(content)]),
    );
    if (previousHash === contentHash) return { changed: false, contentHash, relevantSectionHashes };
    this.store.recordChangeEvent({
      changeId: newId("change"), sourceType: input.sourceType, sourceId: input.sourceId,
      contentHash, ...(previousHash ? { previousHash } : {}), relevantSectionHashes,
      changedAt: new Date().toISOString(),
    });
    return { changed: true, contentHash, ...(previousHash ? { previousHash } : {}), relevantSectionHashes };
  }
}
