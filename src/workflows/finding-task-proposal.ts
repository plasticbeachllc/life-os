import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore, ProposalRecord } from "../db/store";
import { FindingStore } from "../findings/store";
import { sha256Text } from "../util/hashing";
import { newId } from "../util/ids";
import { createEffectProposal } from "../effects/proposals";

const taskInbox = "00 Inbox/Inbox.md";
const eligibleKinds = new Set(["explicit_request", "open_loop", "user_commitment"]);

export function canProposeFindingTask(input: { status: string; owner: string; kind: string }): boolean {
  return input.status === "active" && input.owner === "user" && eligibleKinds.has(input.kind);
}

export async function proposeFindingTask(input: {
  findingId: string; vault: ObsidianVault; store: OperationalStore;
}): Promise<ProposalRecord> {
  input.store.migrate();
  const finding = new FindingStore(input.store).get(input.findingId);
  if (!finding) throw new Error("finding not found");
  if (!canProposeFindingTask(finding)) {
    throw new Error("only active user-owned actionable findings can become task proposals");
  }
  const target = await Bun.file(input.vault.path(taskInbox)).text();
  const targetHash = sha256Text(target);
  const taskId = newId("task");
  const taskLine = taskLineForFinding(finding.statement, finding.dueDate);
  const createdAt = new Date().toISOString();
  return createEffectProposal({ store: input.store,
    proposalId: newId("prop"), runId: newId("run"), actionId: newId("act"),
    workflow: `finding_task_${finding.findingId}`,
    sourceType: "finding", sourceId: finding.findingId, sourceHash: finding.contentHash,
    targetPath: taskInbox, targetHash,
    plan: { type: "finding_task_append", taskLine, taskId, findingId: finding.findingId },
    createdAt, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  });
}

export function taskLineForFinding(statement: string, dueDate: string | null): string {
  return `- [ ] ${statement.trim()}${dueDate ? ` 📅 ${dueDate}` : ""}`;
}
