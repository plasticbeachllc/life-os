import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";

import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore, ProposalRecord } from "../db/store";
import { compileActionPolicy, loadPolicy } from "./loader";
import { disabledActions } from "./invariants";
import { sha256File, sha256Text } from "../util/hashing";

const registeredProposalTools = new Set([
  "apply_frontmatter_patch",
  "apply_task_id_patch",
  "bootstrap_policy_file",
]);

export async function prepareProposalAuthorization(input: {
  proposalId: string; vault: ObsidianVault; store: OperationalStore; ttlSeconds?: number;
}): Promise<{
  token: string; expiresAt: string; proposalId: string; actionId: string;
  targetPath: string; preview: string; expectedTargetHash: string;
}> {
  const proposal = requireApplicableProposal(input.store, input.proposalId);
  await assertProposalPolicy(proposal, input.vault);
  await assertProposalTargetCurrent(proposal, input.vault);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + (input.ttlSeconds ?? 300) * 1000).toISOString();
  const token = `confirm_${randomBytes(24).toString("hex")}`;
  input.store.saveAuthorizationToken({
    tokenHash: sha256Text(token), purpose: "apply_proposal",
    proposalId: proposal.proposalId, actionId: proposal.actionId,
    expectedTargetHash: proposal.targetHash, createdAt: createdAt.toISOString(), expiresAt,
  });
  return {
    token, expiresAt, proposalId: proposal.proposalId, actionId: proposal.actionId,
    targetPath: proposal.targetPath, preview: String(proposal.arguments.preview ?? "(no preview)"),
    expectedTargetHash: proposal.targetHash,
  };
}

export async function consumeProposalAuthorization(input: {
  token: string; proposalId: string; actionId: string;
  vault: ObsidianVault; store: OperationalStore;
}): Promise<ProposalRecord> {
  const proposal = requireApplicableProposal(input.store, input.proposalId);
  if (proposal.actionId !== input.actionId) throw new Error("action does not belong to proposal");
  await assertProposalPolicy(proposal, input.vault);
  await assertProposalTargetCurrent(proposal, input.vault);
  input.store.consumeAuthorizationToken({
    tokenHash: sha256Text(input.token), purpose: "apply_proposal",
    proposalId: proposal.proposalId, actionId: proposal.actionId,
    expectedTargetHash: proposal.targetHash, now: new Date().toISOString(),
  });
  if (!proposal.approved) {
    input.store.approveProposalAction(proposal.proposalId, proposal.actionId, new Date().toISOString());
  }
  return input.store.getProposal(proposal.proposalId)!;
}

export async function prepareUndoAuthorization(input: {
  actionId: string; vault: ObsidianVault; store: OperationalStore; ttlSeconds?: number;
}): Promise<{ token: string; expiresAt: string; actionId: string; targetPath: string; expectedTargetHash: string }> {
  const record = input.store.getUndoRecord(input.actionId);
  if (!record) throw new Error(`undo record not found: ${input.actionId}`);
  if (record.undoneAt) throw new Error("action has already been undone");
  const currentHash = await currentTargetHash(input.vault, record.targetPath);
  if (currentHash !== record.afterHash) throw new Error("undo target changed after application");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + (input.ttlSeconds ?? 300) * 1000).toISOString();
  const token = `confirm_${randomBytes(24).toString("hex")}`;
  input.store.saveAuthorizationToken({
    tokenHash: sha256Text(token), purpose: "undo_action", actionId: input.actionId,
    expectedTargetHash: record.afterHash, createdAt: createdAt.toISOString(), expiresAt,
  });
  return { token, expiresAt, actionId: input.actionId, targetPath: record.targetPath, expectedTargetHash: record.afterHash };
}

export async function consumeUndoAuthorization(input: {
  token: string; actionId: string; vault: ObsidianVault; store: OperationalStore;
}): Promise<void> {
  const record = input.store.getUndoRecord(input.actionId);
  if (!record || record.undoneAt) throw new Error("active undo record not found");
  if (await currentTargetHash(input.vault, record.targetPath) !== record.afterHash) {
    throw new Error("undo target changed after application");
  }
  input.store.consumeAuthorizationToken({
    tokenHash: sha256Text(input.token), purpose: "undo_action", actionId: input.actionId,
    expectedTargetHash: record.afterHash, now: new Date().toISOString(),
  });
}

function requireApplicableProposal(store: OperationalStore, proposalId: string): ProposalRecord {
  const proposal = store.getProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
  if (!["pending", "approved"].includes(proposal.lifecycleState)) throw new Error(`proposal cannot be applied from state: ${proposal.lifecycleState}`);
  if (proposal.expiresAt && new Date(proposal.expiresAt).getTime() <= Date.now()) throw new Error("proposal has expired");
  if (proposal.permissionClass === "red" || disabledActions.has(proposal.toolName)) throw new Error("red action cannot be authorized");
  if (!registeredProposalTools.has(proposal.toolName)) throw new Error(`proposal tool is not registered: ${proposal.toolName}`);
  return proposal;
}

async function assertProposalPolicy(proposal: ProposalRecord, vault: ObsidianVault): Promise<void> {
  if (proposal.toolName === "bootstrap_policy_file") return;
  const actionName = proposal.toolName === "apply_task_id_patch" ? "create_task" : proposal.toolName;
  const decision = compileActionPolicy(await loadPolicy(vault), actionName);
  if (!decision.allowed || !decision.requiresApproval) throw new Error(`policy does not permit approval for ${actionName}`);
}

async function assertProposalTargetCurrent(proposal: ProposalRecord, vault: ObsidianVault): Promise<void> {
  if (await currentTargetHash(vault, proposal.targetPath) !== proposal.targetHash) {
    throw new Error("proposal target changed; regenerate proposal");
  }
}

async function currentTargetHash(vault: ObsidianVault, relativePath: string): Promise<string> {
  const root = resolve(vault.root);
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("target escapes vault root");
  return existsSync(path) ? sha256File(path) : "missing";
}
