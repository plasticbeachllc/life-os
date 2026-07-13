import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore, ProposalRecord } from "../db/store";
import { sha256Text } from "../util/hashing";
import { newId } from "../util/ids";
import { markdownTasks } from "../util/markdown";
import { createEffectProposal, findCurrentEffectProposal } from "../effects/proposals";

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
    const prior = findCurrentEffectProposal({
      store: input.store, workflow: "normalize_task_ids", targetPath: note.relativePath,
      targetHash, effectType: "task_id_patch",
    });
    if (prior) {
      existing.push(prior);
      continue;
    }
    const patches: TaskIdPatch[] = missing.map((task) => ({
      line: task.line, taskText: task.text, taskId: newId("task"),
    }));
    const createdAt = new Date().toISOString();
    created.push(createEffectProposal({ store: input.store,
      proposalId: newId("prop"), runId: newId("run"), actionId: newId("act"),
      workflow: "normalize_task_ids", sourceType: "obsidian", sourceId: note.relativePath,
      sourceHash: targetHash, targetPath: note.relativePath, targetHash,
      plan: { type: "task_id_patch", patches },
      createdAt, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }));
  }
  return { created, existing };
}
