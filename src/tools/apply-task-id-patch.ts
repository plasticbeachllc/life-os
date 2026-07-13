import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore } from "../db/store";
import { compileActionPolicy, loadPolicy } from "../policy/loader";
import { sha256Text } from "../util/hashing";
import { newId } from "../util/ids";
import { requireEffectPlan } from "../effects/contract";

export async function applyTaskIdProposal(input: {
  proposalId: string; vault: ObsidianVault; store: OperationalStore; backupRoot: string;
}): Promise<{ actionId: string; targetPath: string; beforeHash: string; afterHash: string; backupPath: string }> {
  const proposal = input.store.getProposal(input.proposalId);
  if (!proposal) throw new Error(`proposal not found: ${input.proposalId}`);
  if (proposal.workflow !== "normalize_task_ids") throw new Error("not a task ID proposal");
  const plan = requireEffectPlan(proposal, "task_id_patch");
  if (proposal.lifecycleState !== "approved" || !proposal.approved) throw new Error("proposal action requires explicit approval");
  if (proposal.expiresAt && new Date(proposal.expiresAt).getTime() <= Date.now()) throw new Error("proposal has expired");
  const decision = compileActionPolicy(await loadPolicy(input.vault), "create_task");
  if (!decision.allowed || !decision.requiresApproval) throw new Error("policy does not permit approved task normalization");

  const vaultRoot = resolve(input.vault.root);
  const targetPath = resolve(vaultRoot, proposal.targetPath);
  if (!targetPath.startsWith(`${vaultRoot}${sep}`) || !proposal.targetPath.endsWith(".md")) throw new Error("task target escapes Markdown allowlist");
  const before = await Bun.file(targetPath).text();
  const beforeHash = sha256Text(before);
  if (beforeHash !== proposal.targetHash || beforeHash !== proposal.sourceHash) throw new Error("target changed since proposal creation; regenerate proposal");
  const patches = plan.patches;
  const lines = before.split(/\r?\n/);
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  for (const patch of [...patches].sort((left, right) => right.line - left.line)) {
    const line = lines[patch.line - 1];
    if (!line || !line.includes(patch.taskText) || !/^\s*-\s+\[[ xX]\]/.test(line)) {
      throw new Error(`task line no longer matches at line ${patch.line}`);
    }
    const indentation = line.match(/^(\s*)/)?.[1] ?? "";
    lines.splice(patch.line, 0, `${indentation}  <!-- life-os:task_id=${patch.taskId} -->`);
  }
  const after = lines.join(newline);
  const afterHash = sha256Text(after);
  const backupDir = resolve(input.backupRoot, proposal.runId);
  mkdirSync(backupDir, { recursive: true });
  const backupPath = resolve(backupDir, basename(targetPath));
  copyFileSync(targetPath, backupPath);
  const temporaryPath = resolve(dirname(targetPath), `.${basename(targetPath)}.${newId("act")}.tmp`);
  try {
    writeFileSync(temporaryPath, after, "utf8");
    if (sha256Text(await Bun.file(temporaryPath).text()) !== afterHash) throw new Error("temporary write verification failed");
    renameSync(temporaryPath, targetPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  if (sha256Text(await Bun.file(targetPath).text()) !== afterHash) throw new Error("post-write verification failed");
  input.store.markProposalApplied({
    proposalId: proposal.proposalId, actionId: proposal.actionId, appliedAt: new Date().toISOString(),
    targetHash: afterHash, backupPath, beforeHash, afterHash,
  });
  input.store.recordActionResult({
    actionId: proposal.actionId, runId: proposal.runId, ok: true,
    message: "stable task IDs applied", filesModified: [proposal.targetPath],
  });
  return { actionId: proposal.actionId, targetPath: proposal.targetPath, beforeHash, afterHash, backupPath };
}
