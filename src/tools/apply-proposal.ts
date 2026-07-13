import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore } from "../db/store";
import { consumeProposalAuthorization } from "../policy/authorization";
import { getEffectExecutor } from "../effects/registry";

export async function applyProposalWithAuthorization(input: {
  token: string; proposalId: string; actionId: string;
  vault: ObsidianVault; store: OperationalStore; backupRoot: string;
}): Promise<{ actionId: string; targetPath: string; backupPath: string }> {
  const proposal = await consumeProposalAuthorization(input);
  const executor = getEffectExecutor(proposal.effectType);
  if (executor.version !== proposal.executorVersion) throw new Error("effect executor version changed; regenerate proposal");
  return executor.apply({
    proposalId: proposal.proposalId, vault: input.vault,
    store: input.store, backupRoot: input.backupRoot,
  });
}

export async function applyEffectProposal(input: {
  proposalId: string; vault: ObsidianVault; store: OperationalStore; backupRoot: string;
}): Promise<{ actionId: string; targetPath: string; backupPath: string }> {
  const proposal = input.store.getProposal(input.proposalId);
  if (!proposal) throw new Error(`proposal not found: ${input.proposalId}`);
  const executor = getEffectExecutor(proposal.effectType);
  if (executor.version !== proposal.executorVersion) throw new Error("effect executor version changed; regenerate proposal");
  return executor.apply(input);
}
