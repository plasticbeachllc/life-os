import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore, ProposalRecord } from "../db/store";
import { backfillExtractionFindings } from "../findings/projector";
import { FindingStore } from "../findings/store";
import { proposeFindingTask } from "./finding-task-proposal";

/** Compatibility entry point for the original extraction-ID plus item-index surface. */
export async function proposeEmailExtractionTask(input: {
  extractionId: string; itemIndex: number; vault: ObsidianVault; store: OperationalStore;
}): Promise<ProposalRecord> {
  input.store.migrate();
  if (!Number.isInteger(input.itemIndex) || input.itemIndex < 0) {
    throw new Error("invalid extraction item selection");
  }
  backfillExtractionFindings(input.store);
  const finding = new FindingStore(input.store).findBySource(
    "gmail_extraction", input.extractionId, input.itemIndex,
  );
  if (!finding) throw new Error("email extraction item finding not found");
  return proposeFindingTask({ findingId: finding.findingId, vault: input.vault, store: input.store });
}
