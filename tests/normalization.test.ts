import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ObsidianVault } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import { applyApprovedProposal } from "../src/tools/apply-frontmatter-patch";
import { reviewEffectProposal } from "../src/effects/registry";
import { undoAction } from "../src/tools/undo-action";
import { proposeMetadataNormalization } from "../src/workflows/normalize-metadata";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function fixture(): { vault: ObsidianVault; store: OperationalStore; notePath: string; backupRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "life-os-normalize-"));
  const notePath = join(root, "30 People/Nicholas.md");
  write(notePath, `---
last_contact:
next_contact:
---
## Context

Friend.
`);
  for (const file of ["Constitution.md", "Permissions.md", "Schemas.md", "Agent.md"]) {
    write(join(root, "90 System/AI", file), `# ${file}\n`);
  }
  write(join(root, "90 System/AI/permissions.toml"), "[actions]\n");
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-normalize-db-")), "store.db"));
  const backupRoot = mkdtempSync(join(tmpdir(), "life-os-backups-"));
  return { vault: new ObsidianVault(root), store, notePath, backupRoot };
}

test("normalization proposal is stable and requires approval", async () => {
  const { vault, store, notePath, backupRoot } = fixture();
  const first = await proposeMetadataNormalization({ vault, store });
  const second = await proposeMetadataNormalization({ vault, store });
  const proposal = first.created[0]!;

  expect(first.created).toHaveLength(1);
  expect(second.existing[0]?.proposalId).toBe(proposal.proposalId);
  expect(reviewEffectProposal(proposal).preview).toContain("+type: person");
  expect(reviewEffectProposal(proposal).preview).toContain("+id: person_");
  expect(applyApprovedProposal({ proposalId: proposal.proposalId, vault, store, backupRoot })).rejects.toThrow("explicit approval");

  store.approveProposalAction(proposal.proposalId, proposal.actionId, new Date().toISOString());
  const result = await applyApprovedProposal({ proposalId: proposal.proposalId, vault, store, backupRoot });
  const updated = await Bun.file(notePath).text();
  expect(updated).toContain("last_contact:\nnext_contact:\ntype: person\nid: person_");
  expect(updated).toContain("## Context\n\nFriend.");
  expect(existsSync(result.backupPath)).toBe(true);
  expect(store.countRows("approvals")).toBe(1);
  expect(store.countRows("undo_records")).toBe(1);

  await undoAction({ actionId: proposal.actionId, vault, store });
  expect(await Bun.file(notePath).text()).not.toContain("type: person");
  expect(store.getUndoRecord(proposal.actionId)?.undoneAt).toBeDefined();
});

test("application rejects a target changed after proposal creation", async () => {
  const { vault, store, notePath, backupRoot } = fixture();
  const proposal = (await proposeMetadataNormalization({ vault, store })).created[0]!;
  store.approveProposalAction(proposal.proposalId, proposal.actionId, new Date().toISOString());
  write(notePath, `${await Bun.file(notePath).text()}\nConcurrent edit.\n`);

  expect(applyApprovedProposal({ proposalId: proposal.proposalId, vault, store, backupRoot })).rejects.toThrow("target changed");
  expect(store.countRows("undo_records")).toBe(0);
});
