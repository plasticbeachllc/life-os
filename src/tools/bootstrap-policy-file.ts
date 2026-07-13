import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore } from "../db/store";
import { mandatoryPolicyFiles, parsePermissions } from "../policy/loader";
import { sha256Text } from "../util/hashing";
import { newId } from "../util/ids";
import { requireEffectPlan } from "../effects/contract";

const bootstrapTargets = new Set(Object.values(mandatoryPolicyFiles));

export async function applyPolicyBootstrapProposal(input: {
  proposalId: string; vault: ObsidianVault; store: OperationalStore; backupRoot: string;
}): Promise<{ actionId: string; targetPath: string; afterHash: string; backupPath: string }> {
  const proposal = input.store.getProposal(input.proposalId);
  if (!proposal) throw new Error(`proposal not found: ${input.proposalId}`);
  if (proposal.workflow !== "bootstrap_policy") throw new Error("not a policy bootstrap proposal");
  const plan = requireEffectPlan(proposal, "policy_bootstrap");
  if (proposal.lifecycleState !== "approved" || !proposal.approved) throw new Error("proposal action requires explicit approval");
  if (proposal.expiresAt && new Date(proposal.expiresAt).getTime() <= Date.now()) throw new Error("proposal has expired");
  if (!bootstrapTargets.has(proposal.targetPath as never)) throw new Error("target is outside bootstrap allowlist");
  if (proposal.targetHash !== "missing") throw new Error("bootstrap target must have been absent");
  const content = plan.content;
  if (proposal.targetPath.endsWith("permissions.toml")) parsePermissions(content);
  const sourcePath = plan.sourcePath;
  if (sourcePath !== undefined) {
    if (typeof sourcePath !== "string" || !sourcePath.startsWith("90 System/AI/")) throw new Error("bootstrap source is invalid");
    const currentSource = await Bun.file(input.vault.path(sourcePath)).text();
    if (sha256Text(currentSource) !== proposal.sourceHash) throw new Error("bootstrap source changed; regenerate proposal");
  } else if (sha256Text(content) !== proposal.sourceHash) {
    throw new Error("generated bootstrap content hash mismatch");
  }

  const vaultRoot = resolve(input.vault.root);
  const targetPath = resolve(vaultRoot, proposal.targetPath);
  if (!targetPath.startsWith(`${vaultRoot}${sep}`)) throw new Error("resolved target escapes vault root");
  if (existsSync(targetPath)) throw new Error("bootstrap target now exists; proposal is stale");
  const afterHash = sha256Text(content);
  const backupDir = resolve(input.backupRoot, proposal.runId);
  mkdirSync(backupDir, { recursive: true });
  const backupPath = resolve(backupDir, `${basename(targetPath)}.absence.json`);
  writeFileSync(backupPath, JSON.stringify({ targetExisted: false, targetPath: proposal.targetPath }), "utf8");
  mkdirSync(dirname(targetPath), { recursive: true });
  const temporaryPath = resolve(dirname(targetPath), `.${basename(targetPath)}.${newId("act")}.tmp`);
  try {
    writeFileSync(temporaryPath, content, "utf8");
    if (sha256Text(await Bun.file(temporaryPath).text()) !== afterHash) throw new Error("temporary write verification failed");
    renameSync(temporaryPath, targetPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  if (sha256Text(await Bun.file(targetPath).text()) !== afterHash) throw new Error("post-write verification failed");
  input.store.markProposalApplied({
    proposalId: proposal.proposalId, actionId: proposal.actionId, appliedAt: new Date().toISOString(),
    targetHash: afterHash, backupPath, beforeHash: "missing", afterHash,
  });
  input.store.recordActionResult({
    actionId: proposal.actionId, runId: proposal.runId, ok: true,
    message: "policy file bootstrapped", filesModified: [proposal.targetPath],
  });
  return { actionId: proposal.actionId, targetPath: proposal.targetPath, afterHash, backupPath };
}
