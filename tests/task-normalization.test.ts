import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ObsidianVault } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import { applyTaskIdProposal } from "../src/tools/apply-task-id-patch";
import { requireEffectPlan } from "../src/effects/contract";
import { undoAction } from "../src/tools/undo-action";
import { proposeTaskIdNormalization } from "../src/workflows/normalize-task-ids";
import { rebuildState } from "../src/workflows/rebuild-state";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function fixture(): { vault: ObsidianVault; store: OperationalStore; notePath: string; backupRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "life-os-task-normalize-"));
  const notePath = join(root, "10 Journal/2026/2026-07-12.md");
  write(notePath, "# Day\n\n- [ ] First task\n- [x] Second task ✅ 2026-07-12\n");
  for (const file of ["Constitution.md", "Permissions.md", "Schemas.md", "Agent.md"]) {
    write(join(root, "90 System/AI", file), `# ${file}\n`);
  }
  write(join(root, "90 System/AI/permissions.toml"), `[actions.create_task]\nenabled = true\nmode = "proposal"\n`);
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-task-normalize-db-")), "store.db"));
  return {
    vault: new ObsidianVault(root), store, notePath,
    backupRoot: mkdtempSync(join(tmpdir(), "life-os-task-normalize-backups-")),
  };
}

test("task normalization patches a note atomically and enables task projection", async () => {
  const { vault, store, notePath, backupRoot } = fixture();
  const first = await proposeTaskIdNormalization({ vault, store });
  const proposal = first.created[0]!;
  expect(first.created).toHaveLength(1);
  expect(requireEffectPlan(proposal, "task_id_patch").patches).toHaveLength(2);
  expect((await proposeTaskIdNormalization({ vault, store })).existing[0]?.proposalId).toBe(proposal.proposalId);

  store.approveProposalAction(proposal.proposalId, proposal.actionId, new Date().toISOString());
  await applyTaskIdProposal({ proposalId: proposal.proposalId, vault, store, backupRoot });
  expect((await Bun.file(notePath).text()).match(/life-os:task_id=/g)).toHaveLength(2);

  const report = await rebuildState({ vault, store });
  expect(report.tasks).toBe(2);
  expect(report.issues).toEqual([]);
  expect(store.listCurrentDerivedStates("task_state")).toHaveLength(2);

  await undoAction({ actionId: proposal.actionId, vault, store });
  expect(await Bun.file(notePath).text()).not.toContain("life-os:task_id=");
});

test("task normalization rejects concurrent source changes", async () => {
  const { vault, store, notePath, backupRoot } = fixture();
  const proposal = (await proposeTaskIdNormalization({ vault, store })).created[0]!;
  store.approveProposalAction(proposal.proposalId, proposal.actionId, new Date().toISOString());
  write(notePath, `${await Bun.file(notePath).text()}Concurrent edit.\n`);
  expect(applyTaskIdProposal({ proposalId: proposal.proposalId, vault, store, backupRoot })).rejects.toThrow("target changed");
});
