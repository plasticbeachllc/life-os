import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore, ProposalRecord } from "../db/store";
import { sha256Text } from "../util/hashing";
import { newId } from "../util/ids";
import { markdownTasks } from "../util/markdown";

export interface TaskIdPatch {
  line: number;
  taskText: string;
  taskId: string;
}

export async function proposeTaskIdNormalization(input: {
  vault: ObsidianVault; store: OperationalStore;
}): Promise<{ created: ProposalRecord[]; existing: ProposalRecord[] }> {
  input.vault.requireExists();
  input.store.migrate();
  const created: ProposalRecord[] = [];
  const existing: ProposalRecord[] = [];

  for (const note of await input.vault.notes()) {
    const missing = markdownTasks(note.raw).filter((task) => !task.taskId);
    if (missing.length === 0) continue;
    const targetHash = sha256Text(note.raw);
    const prior = input.store.findProposal("normalize_task_ids", note.relativePath, targetHash);
    if (prior) {
      existing.push(prior);
      continue;
    }
    const patches: TaskIdPatch[] = missing.map((task) => ({
      line: task.line, taskText: task.text, taskId: newId("task"),
    }));
    const createdAt = new Date().toISOString();
    created.push(input.store.createProposal({
      proposalId: newId("prop"), runId: newId("run"), actionId: newId("act"),
      workflow: "normalize_task_ids", sourceType: "obsidian", sourceId: note.relativePath,
      sourceHash: targetHash, targetPath: note.relativePath, targetHash,
      toolName: "apply_task_id_patch", permissionClass: "yellow",
      arguments: {
        patches,
        preview: patches.map((patch) => `@@ line ${patch.line}\n+  <!-- life-os:task_id=${patch.taskId} -->`).join("\n"),
      },
      createdAt, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }));
  }
  return { created, existing };
}
