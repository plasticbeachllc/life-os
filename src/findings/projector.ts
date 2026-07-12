import type { OperationalStore } from "../db/store";
import { GmailStore } from "../gmail/store";
import { IMessageStore } from "../imessage/store";
import { sha256Value } from "../util/hashing";
import {
  semanticFindingKinds, semanticFindingOwners,
  type ExtractionRecordForProjection, type SemanticFinding,
} from "./contract";
import { FindingStore } from "./store";

export function projectExtractionFindings(input: {
  store: OperationalStore;
  extraction: ExtractionRecordForProjection;
}): { created: number; unchanged: number } {
  const items = Array.isArray(input.extraction.output.items) ? input.extraction.output.items : [];
  const findings = items.map((item, index) => toFinding(input.extraction, item, index));
  return new FindingStore(input.store).saveProjection(findings);
}

export function backfillExtractionFindings(store: OperationalStore): {
  extractions: number; created: number; unchanged: number;
} {
  store.migrate();
  const extractions = [
    ...new GmailStore(store).listExtractionsForFindingProjection(),
    ...new IMessageStore(store).listExtractionsForFindingProjection(),
  ];
  let created = 0;
  let unchanged = 0;
  for (const extraction of extractions) {
    const result = projectExtractionFindings({ store, extraction });
    created += result.created;
    unchanged += result.unchanged;
  }
  return { extractions: extractions.length, created, unchanged };
}

function toFinding(
  extraction: ExtractionRecordForProjection, value: unknown, sourceItemIndex: number,
): SemanticFinding {
  if (!value || typeof value !== "object") throw new Error("extraction item cannot be projected to a finding");
  const item = value as Record<string, unknown>;
  if (!semanticFindingKinds.includes(item.kind as never)
    || !semanticFindingOwners.includes(item.owner as never)
    || typeof item.statement !== "string" || !item.statement.trim()
    || typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1
    || !(item.dueDate === null || typeof item.dueDate === "string")
    || !Array.isArray(item.ambiguities) || item.ambiguities.some((entry) => typeof entry !== "string")
    || !Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0
    || item.evidenceIds.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error("extraction item cannot be projected to a finding");
  }
  const semantic = {
    kind: item.kind as SemanticFinding["kind"],
    statement: item.statement.trim(),
    owner: item.owner as SemanticFinding["owner"],
    dueDate: item.dueDate as string | null,
    confidence: item.confidence,
    ambiguities: item.ambiguities as string[],
    evidenceIds: item.evidenceIds as string[],
  };
  const identity = {
    sourceType: extraction.sourceType,
    sourceExtractionId: extraction.extractionId,
    sourceItemIndex,
  };
  return {
    findingId: `finding_${sha256Value(identity).slice("sha256:".length, "sha256:".length + 24)}`,
    ...identity,
    reasoningCallId: extraction.callId,
    ...semantic,
    contentHash: sha256Value({ ...identity, ...semantic }),
    createdAt: extraction.createdAt,
  };
}
