import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore, ProposalRecord } from "../db/store";
import { GmailStore } from "../gmail/store";
import { sha256Text } from "../util/hashing";
import { newId } from "../util/ids";

const taskInbox = "00 Inbox/Inbox.md";

export async function proposeEmailExtractionTask(input: {
  extractionId: string; itemIndex: number; vault: ObsidianVault; store: OperationalStore;
}): Promise<ProposalRecord> {
  input.store.migrate();
  const extraction = new GmailStore(input.store).getExtraction(input.extractionId);
  if (!extraction) throw new Error("email extraction not found");
  const items = Array.isArray(extraction.output.items) ? extraction.output.items : [];
  const item = items[input.itemIndex];
  if (!item || typeof item !== "object") throw new Error("extraction item not found");
  const record = item as Record<string, unknown>;
  if (!Number.isInteger(input.itemIndex) || input.itemIndex < 0 || typeof record.statement !== "string") {
    throw new Error("invalid extraction item selection");
  }
  if (record.owner !== "user" || !["explicit_request", "open_loop", "user_commitment"].includes(String(record.kind))) {
    throw new Error("only user-owned actionable extraction items can become task proposals");
  }
  const target = await Bun.file(input.vault.path(taskInbox)).text();
  const targetHash = sha256Text(target);
  const taskId = newId("task");
  const dueDate = typeof record.dueDate === "string" ? record.dueDate : undefined;
  const taskLine = `- [ ] ${record.statement.trim()}${dueDate ? ` 📅 ${dueDate}` : ""}`;
  const createdAt = new Date().toISOString();
  return input.store.createProposal({
    proposalId: newId("prop"), runId: newId("run"), actionId: newId("act"),
    workflow: "email_extraction_task", sourceType: "gmail_extraction", sourceId: input.extractionId,
    sourceHash: extraction.sourceHash, targetPath: taskInbox, targetHash,
    toolName: "append_email_task", permissionClass: "yellow",
    arguments: { taskLine, taskId, extractionId: input.extractionId, itemIndex: input.itemIndex,
      preview: `+ ${taskLine}\n+   <!-- life-os:task_id=${taskId} source=${input.extractionId} -->` },
    createdAt, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  });
}
