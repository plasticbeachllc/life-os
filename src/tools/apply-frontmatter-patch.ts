import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore } from "../db/store";
import { loadPolicy } from "../policy/loader";
import { sha256Text } from "../util/hashing";
import { applyFrontmatterPatch } from "../util/frontmatter-patch";
import { newId } from "../util/ids";
import { requireEffectPlan } from "../effects/contract";

export async function applyApprovedProposal(input: {
  proposalId: string;
  vault: ObsidianVault;
  store: OperationalStore;
  backupRoot: string;
}): Promise<{ actionId: string; targetPath: string; beforeHash: string; afterHash: string; backupPath: string }> {
  const proposal = input.store.getProposal(input.proposalId);
  if (!proposal) throw new Error(`proposal not found: ${input.proposalId}`);
  if (proposal.lifecycleState !== "approved" || !proposal.approved) throw new Error("proposal action requires explicit approval");
  if (proposal.expiresAt && new Date(proposal.expiresAt).getTime() <= Date.now()) throw new Error("proposal has expired");
  const plan = requireEffectPlan(proposal, "frontmatter_patch");
  if (!proposal.targetPath.startsWith("20 Projects/") && !proposal.targetPath.startsWith("30 People/")) {
    throw new Error("target is outside the canonical metadata allowlist");
  }
  const policy = await loadPolicy(input.vault);
  if (Object.keys(policy.missing).length > 0 || policy.errors.length > 0) throw new Error("mandatory policy documents are missing or invalid; apply fails closed");

  const vaultRoot = resolve(input.vault.root);
  const targetPath = resolve(vaultRoot, proposal.targetPath);
  if (!targetPath.startsWith(`${vaultRoot}${sep}`)) throw new Error("resolved target escapes vault root");
  const before = await Bun.file(targetPath).text();
  const beforeHash = sha256Text(before);
  if (beforeHash !== proposal.sourceHash || beforeHash !== proposal.targetHash) {
    throw new Error("target changed since proposal creation; regenerate proposal");
  }
  const after = applyFrontmatterPatch(before, { additions: plan.additions });
  const afterHash = sha256Text(after);
  if (afterHash === beforeHash) throw new Error("proposal produces no change");

  const backupDir = resolve(input.backupRoot, proposal.runId);
  mkdirSync(backupDir, { recursive: true });
  const backupPath = resolve(backupDir, basename(targetPath));
  copyFileSync(targetPath, backupPath);
  const temporaryPath = resolve(dirname(targetPath), `.${basename(targetPath)}.${newId("act")}.tmp`);
  try {
    writeFileSync(temporaryPath, after, "utf8");
    const written = await Bun.file(temporaryPath).text();
    if (sha256Text(written) !== afterHash) throw new Error("temporary write verification failed");
    renameSync(temporaryPath, targetPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  const verifiedHash = sha256Text(await Bun.file(targetPath).text());
  if (verifiedHash !== afterHash) throw new Error("post-write verification failed");
  input.store.markProposalApplied({
    proposalId: proposal.proposalId, actionId: proposal.actionId,
    appliedAt: new Date().toISOString(), targetHash: afterHash,
    backupPath, beforeHash, afterHash,
  });
  input.store.recordActionResult({
    actionId: proposal.actionId, runId: proposal.runId, ok: true,
    message: "frontmatter patch applied", filesModified: [proposal.targetPath],
  });
  return { actionId: proposal.actionId, targetPath: proposal.targetPath, beforeHash, afterHash, backupPath };
}
