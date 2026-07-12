import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore } from "../db/store";
import { compileActionPolicy, loadPolicy } from "../policy/loader";
import { sha256Text } from "../util/hashing";
import { newId } from "../util/ids";

export async function applyEmailTaskProposal(input: { proposalId: string; vault: ObsidianVault;
  store: OperationalStore; backupRoot: string }): Promise<{ actionId: string; targetPath: string; backupPath: string }> {
  const proposal = input.store.getProposal(input.proposalId);
  if (!proposal || proposal.toolName !== "append_email_task" || proposal.workflow !== "email_extraction_task") throw new Error("not an email task proposal");
  return applyInboxTaskProposal(input, {
    toolName: "append_email_task", workflow: "email_extraction_task",
    invalidMessage: "not an email task proposal", resultMessage: "email extraction task appended",
  });
}

export async function applyInboxTaskProposal(
  input: { proposalId: string; vault: ObsidianVault; store: OperationalStore; backupRoot: string },
  contract: {
    toolName: "append_email_task" | "append_finding_task"; workflow: string;
    invalidMessage: string; resultMessage: string;
    findingConversion?: { eventId: string; findingId: string; expectedContentHash: string; taskId: string };
  },
): Promise<{ actionId: string; targetPath: string; backupPath: string }> {
  const proposal = input.store.getProposal(input.proposalId);
  if (!proposal || proposal.toolName !== contract.toolName || proposal.workflow !== contract.workflow) {
    throw new Error(contract.invalidMessage);
  }
  if (!proposal.approved || proposal.lifecycleState !== "approved") throw new Error("proposal requires explicit approval");
  if (proposal.targetPath !== "00 Inbox/Inbox.md") throw new Error("tasks may only target the canonical inbox");
  const decision = compileActionPolicy(await loadPolicy(input.vault), "create_task");
  if (!decision.allowed || !decision.requiresApproval) throw new Error("policy does not permit approved task creation");
  const root = resolve(input.vault.root); const path = resolve(root, proposal.targetPath);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("task target escapes vault");
  const before = await Bun.file(path).text(); const beforeHash = sha256Text(before);
  if (beforeHash !== proposal.targetHash) throw new Error("task inbox changed; regenerate proposal");
  const taskLine = String(proposal.arguments.taskLine ?? ""); const taskId = String(proposal.arguments.taskId ?? "");
  if (!/^- \[ \] \S/.test(taskLine) || !/^task_[a-f0-9]+$/.test(taskId)) throw new Error("task proposal arguments are invalid");
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  const after = `${before.replace(/\s*$/, "")}${newline}${taskLine}${newline}  <!-- life-os:task_id=${taskId} source=${proposal.sourceId} -->${newline}`;
  const afterHash = sha256Text(after); const backupDir = resolve(input.backupRoot, proposal.runId);
  mkdirSync(backupDir, { recursive: true }); const backupPath = resolve(backupDir, basename(path)); copyFileSync(path, backupPath);
  const temporary = resolve(dirname(path), `.${basename(path)}.${newId("act")}.tmp`);
  try { writeFileSync(temporary, after, "utf8"); renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
  try {
    input.store.markProposalApplied({ proposalId: proposal.proposalId, actionId: proposal.actionId,
      appliedAt: new Date().toISOString(), targetHash: afterHash, backupPath, beforeHash, afterHash,
      ...(contract.findingConversion ? { findingConversion: contract.findingConversion } : {}) });
  } catch (error) {
    const rollback = resolve(dirname(path), `.${basename(path)}.${newId("act")}.rollback.tmp`);
    try {
      copyFileSync(backupPath, rollback);
      renameSync(rollback, path);
    } finally {
      rmSync(rollback, { force: true });
    }
    throw error;
  }
  input.store.recordActionResult({ actionId: proposal.actionId, runId: proposal.runId, ok: true,
    message: contract.resultMessage, filesModified: [proposal.targetPath] });
  return { actionId: proposal.actionId, targetPath: proposal.targetPath, backupPath };
}
