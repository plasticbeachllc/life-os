import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore } from "../db/store";
import { browserProposalReview } from "../effects/review-projection";
import { FindingStore } from "../findings/store";
import { sha256Text } from "../util/hashing";
import { proposeFindingTask } from "../workflows/finding-task-proposal";

export function findingUiId(findingId: string): string {
  return `ui_${sha256Text(`finding:${findingId}`).slice(7, 27)}`;
}

/** Resolve an opaque browser finding identity server-side, then create only the fixed inbox proposal. */
export async function proposeFindingTaskFromUi(input: {
  findingUiId: string; vault: ObsidianVault; store: OperationalStore;
}): Promise<ReturnType<typeof browserProposalReview>> {
  if (!/^ui_[a-f0-9]{20}$/.test(input.findingUiId)) throw new Error("invalid finding review identity");
  const finding = new FindingStore(input.store).review().findings.find((candidate) =>
    findingUiId(candidate.findingId) === input.findingUiId);
  if (!finding) throw new Error("finding is not currently reviewable");
  return browserProposalReview(await proposeFindingTask({ findingId: finding.findingId,
    vault: input.vault, store: input.store }));
}
