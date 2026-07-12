import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore } from "../db/store";
import { FindingStore } from "../findings/store";
import { taskLineForFinding } from "../workflows/finding-task-proposal";
import { applyInboxTaskProposal } from "./append-email-task";

export async function applyFindingTaskProposal(input: {
  proposalId: string; vault: ObsidianVault; store: OperationalStore; backupRoot: string;
}): Promise<{ actionId: string; targetPath: string; backupPath: string }> {
  const proposal = input.store.getProposal(input.proposalId);
  if (!proposal || proposal.toolName !== "append_finding_task"
    || proposal.sourceType !== "finding" || proposal.workflow !== `finding_task_${proposal.sourceId}`) {
    throw new Error("not a finding task proposal");
  }
  const finding = new FindingStore(input.store).get(proposal.sourceId);
  if (!finding || finding.status !== "active" || finding.contentHash !== proposal.sourceHash) {
    throw new Error("finding changed; regenerate task proposal");
  }
  const taskId = String(proposal.arguments.taskId ?? "");
  if (proposal.arguments.findingId !== finding.findingId
    || proposal.arguments.taskLine !== taskLineForFinding(finding.statement, finding.dueDate)) {
    throw new Error("finding task proposal arguments are stale or invalid");
  }
  const conversion = new FindingStore(input.store).prepareTaskConversion({
    findingId: finding.findingId, taskId,
  });
  return applyInboxTaskProposal(input, {
    toolName: "append_finding_task", workflow: proposal.workflow,
    invalidMessage: "not a finding task proposal", resultMessage: "finding task appended",
    findingConversion: conversion,
  });
}
