import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ObsidianVault } from "../src/adapters/obsidian";
import { schemaVersion } from "../src/db/schema";
import { OperationalStore } from "../src/db/store";
import {
  consumeUndoAuthorization, prepareProposalAuthorization, prepareUndoAuthorization,
} from "../src/policy/authorization";
import { applyProposalWithAuthorization } from "../src/tools/apply-proposal";
import { undoAction } from "../src/tools/undo-action";
import { proposeMetadataNormalization } from "../src/workflows/normalize-metadata";
import { rebuildState } from "../src/workflows/rebuild-state";

test("fresh schema rebuild and exact proposal apply/undo complete end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "life-os-roadmap-smoke-"));
  const write = (relativePath: string, content: string) => {
    const path = join(root, relativePath); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  };
  for (const file of ["Constitution.md", "Permissions.md", "Schemas.md", "Agent.md"]) {
    write(`90 System/AI/${file}`, `# ${file}\n`);
  }
  write("90 System/AI/permissions.toml",
    `[actions.apply_frontmatter_patch]\nenabled = true\nmode = "proposal"\n`);
  write("30 People/Ada.md", "---\nlast_contact:\n---\n# Ada\n");
  const databasePath = join(root, "operational.db");
  const backupRoot = join(root, "backups");
  const store = new OperationalStore(databasePath); const vault = new ObsidianVault(root);

  const rebuild = await rebuildState({ store, vault, now: new Date("2026-07-12T12:00:00.000Z") });
  expect(store.getSchemaVersion()).toBe(schemaVersion);
  expect(rebuild.issues).toHaveLength(1);
  const proposal = (await proposeMetadataNormalization({ store, vault })).created[0]!;
  const approval = await prepareProposalAuthorization({ proposalId: proposal.proposalId, store, vault });
  const applied = await applyProposalWithAuthorization({
    token: approval.token, proposalId: proposal.proposalId, actionId: proposal.actionId,
    store, vault, backupRoot,
  });
  expect(await Bun.file(vault.path(proposal.targetPath)).text()).toContain("type: person");
  expect((await rebuildState({ store, vault, now: new Date("2026-07-12T12:05:00.000Z") })).people).toBe(1);
  const undo = await prepareUndoAuthorization({ actionId: applied.actionId, store, vault });
  expect(undo.expectedTargetHash).toStartWith("sha256:");
  await consumeUndoAuthorization({ token: undo.token, actionId: applied.actionId, store, vault });
  await undoAction({ actionId: applied.actionId, store, vault });
  expect(await Bun.file(vault.path(proposal.targetPath)).text()).not.toContain("type: person");
});
