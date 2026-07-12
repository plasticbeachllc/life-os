import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore, ProposalRecord } from "../db/store";
import { applyPolicyBootstrapProposal } from "../tools/bootstrap-policy-file";
import { sha256Value } from "../util/hashing";

export interface PolicyBootstrapSet {
  confirmationToken: string;
  proposals: ProposalRecord[];
}

export function pendingPolicyBootstrapSet(store: OperationalStore): PolicyBootstrapSet {
  const proposals = store.listPendingProposals()
    .filter((proposal) => proposal.workflow === "bootstrap_policy")
    .sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  return { confirmationToken: confirmationToken(proposals), proposals };
}

export async function applyPolicyBootstrapSet(input: {
  confirmationToken: string;
  vault: ObsidianVault;
  store: OperationalStore;
  backupRoot: string;
}): Promise<{ applied: Array<{ proposalId: string; actionId: string; targetPath: string }> }> {
  const set = pendingPolicyBootstrapSet(input.store);
  if (set.proposals.length === 0) throw new Error("no pending policy bootstrap proposals");
  if (input.confirmationToken !== set.confirmationToken) {
    throw new Error("bootstrap confirmation token does not match the current pending set");
  }
  const applied: Array<{ proposalId: string; actionId: string; targetPath: string }> = [];
  for (const proposal of set.proposals) {
    if (!proposal.approved) {
      input.store.approveProposalAction(proposal.proposalId, proposal.actionId, new Date().toISOString());
    }
    const result = await applyPolicyBootstrapProposal({
      proposalId: proposal.proposalId, vault: input.vault,
      store: input.store, backupRoot: input.backupRoot,
    });
    applied.push({ proposalId: proposal.proposalId, actionId: result.actionId, targetPath: result.targetPath });
  }
  return { applied };
}

function confirmationToken(proposals: ProposalRecord[]): string {
  if (proposals.length === 0) return "none";
  const hash = sha256Value(proposals.map((proposal) => ({
    proposalId: proposal.proposalId,
    actionId: proposal.actionId,
    targetPath: proposal.targetPath,
    targetHash: proposal.targetHash,
    sourceHash: proposal.sourceHash,
  })));
  return `bootstrap_${hash.replace("sha256:", "").slice(0, 16)}`;
}
