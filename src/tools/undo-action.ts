import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore } from "../db/store";
import { sha256File } from "../util/hashing";
import { newId } from "../util/ids";

export async function undoAction(input: {
  actionId: string; vault: ObsidianVault; store: OperationalStore;
}): Promise<{ actionId: string; targetPath: string; restoredHash: string }> {
  const record = input.store.getUndoRecord(input.actionId);
  if (!record) throw new Error(`undo record not found: ${input.actionId}`);
  if (record.undoneAt) throw new Error("action has already been undone");
  const vaultRoot = resolve(input.vault.root);
  const targetPath = resolve(vaultRoot, record.targetPath);
  if (!targetPath.startsWith(`${vaultRoot}${sep}`)) throw new Error("undo target escapes vault root");
  if (!existsSync(targetPath)) throw new Error("undo target is missing");
  if (await sha256File(targetPath) !== record.afterHash) throw new Error("undo target changed after application");

  if (record.beforeHash === "missing") {
    rmSync(targetPath);
  } else {
    if (!existsSync(record.backupPath)) throw new Error("undo backup is missing");
    if (await sha256File(record.backupPath) !== record.beforeHash) throw new Error("undo backup hash mismatch");
    const temporaryPath = resolve(dirname(targetPath), `.${basename(targetPath)}.${newId("act")}.undo.tmp`);
    try {
      copyFileSync(record.backupPath, temporaryPath);
      renameSync(temporaryPath, targetPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
  const restoredHash = record.beforeHash;
  input.store.markActionUndone(input.actionId, new Date().toISOString());
  return { actionId: input.actionId, targetPath: record.targetPath, restoredHash };
}
