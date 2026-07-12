import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore } from "../db/store";
import { consumeProposalAuthorization } from "../policy/authorization";
import { applyApprovedProposal } from "./apply-frontmatter-patch";
import { applyPolicyBootstrapProposal } from "./bootstrap-policy-file";
import { applyTaskIdProposal } from "./apply-task-id-patch";

export async function applyProposalWithAuthorization(input: {
  token: string; proposalId: string; actionId: string;
  vault: ObsidianVault; store: OperationalStore; backupRoot: string;
}): Promise<{ actionId: string; targetPath: string; backupPath: string }> {
  const proposal = await consumeProposalAuthorization(input);
  const toolInput = {
    proposalId: proposal.proposalId, vault: input.vault,
    store: input.store, backupRoot: input.backupRoot,
  };
  if (proposal.toolName === "bootstrap_policy_file") return applyPolicyBootstrapProposal(toolInput);
  if (proposal.toolName === "apply_task_id_patch") return applyTaskIdProposal(toolInput);
  if (proposal.toolName === "apply_frontmatter_patch") return applyApprovedProposal(toolInput);
  throw new Error(`proposal tool is not registered: ${proposal.toolName}`);
}
