import { ObsidianVault } from "../adapters/obsidian";
import { loadConfig } from "../config";
import { OperationalStore, type ProposalRecord } from "../db/store";
import { reviewEffectProposal } from "../effects/registry";
import { applyEffectProposal } from "../tools/apply-proposal";
import { undoAction } from "../tools/undo-action";

export async function runProposalCommand(input: {
  command: string | undefined; rest: string[]; write?: (value: string) => void;
}): Promise<number | undefined> {
  if (!input.command || !["review", "approve", "apply", "undo"].includes(input.command)) {
    return undefined;
  }
  const args = parseFlags(input.rest);
  const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
  const store = new OperationalStore(config.databasePath); store.migrate();
  const write = input.write ?? console.log;
  if (input.command === "review") {
    const proposalId = args.positionals[0];
    const proposals = proposalId
      ? [store.getProposal(proposalId)].filter((item): item is ProposalRecord => Boolean(item))
      : store.listPendingProposals();
    if (proposalId && proposals.length === 0) throw new Error(`proposal not found: ${proposalId}`);
    write(proposals.length === 0 ? "No pending proposals." : proposals.map(formatProposal).join("\n"));
    return 0;
  }
  const id = args.positionals[0];
  if (!id) throw new Error(`${input.command} requires <${input.command === "undo" ? "action" : "proposal"}-id>`);
  if (input.command === "approve") {
    const actionId = args.flags.action;
    if (!actionId) throw new Error("approve requires <proposal-id> --action <action-id>");
    store.approveProposalAction(id, actionId, new Date().toISOString());
    write(`Approved ${actionId} in ${id}`);
    return 0;
  }
  const vault = new ObsidianVault(config.vaultPath);
  if (input.command === "apply") {
    const result = await applyEffectProposal({
      proposalId: id, vault, store, backupRoot: config.backupPath,
    });
    write(`Applied ${result.actionId} to ${result.targetPath}\nBackup: ${result.backupPath}`);
    return 0;
  }
  const result = await undoAction({ actionId: id, vault, store });
  write(`Undid ${result.actionId} on ${result.targetPath}`);
  return 0;
}

function parseFlags(args: string[]): { flags: Record<string, string>; positionals: string[] } {
  const flags: Record<string, string> = {}; const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]; if (!arg) continue;
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const key = arg.slice(2); const next = args[index + 1];
    if (!next || next.startsWith("--")) flags[key] = "true";
    else { flags[key] = next; index += 1; }
  }
  return { flags, positionals };
}

export function formatProposal(proposal: ProposalRecord): string {
  const review = reviewEffectProposal(proposal);
  return [
    "", `Proposal: ${proposal.proposalId} [${proposal.lifecycleState}]`,
    `Action: ${proposal.actionId} (${proposal.permissionClass})`,
    `Target: ${proposal.targetPath}`, `Expected hash: ${proposal.targetHash}`,
    "Proposed diff:", review.preview,
    `Approve: life-os approve ${proposal.proposalId} --action ${proposal.actionId} --vault <path>`,
  ].join("\n");
}
