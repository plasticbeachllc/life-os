import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";
import { createEffectProposal } from "../src/effects/proposals";
import { compileUiWorkspace } from "../src/ui/workspace";

test("browser workspace represents operational states without private identities or excerpts", async () => {
  const root = mkdtempSync(join(tmpdir(), "life-os-workspace-"));
  const databasePath = join(root, "store.db");
  const store = new OperationalStore(databasePath); store.migrate();
  createEffectProposal({
    store, proposalId: "prop_private_internal", runId: "run_ui", actionId: "act_private_internal",
    workflow: "finding_task", sourceType: "finding", sourceId: "provider-message-private",
    sourceHash: "sha256:private-source-hash", targetPath: "00 Inbox/Inbox.md", targetHash: "sha256:target",
    plan: { type: "finding_task_append", findingId: "finding_abcdef", taskId: "task_abcdef",
      taskLine: "- [ ] PRIVATE SOURCE EXCERPT from private@example.com" },
    createdAt: "2026-07-12T12:00:00.000Z",
  });
  store.saveDerivedState({
    stateId: "state_private", stateType: "finding_attention_state", stateVersion: 1,
    content: { open_loop_count: 1, overdue_count: 0,
      open_loops: [{ kind: "explicit_request", statement: "PRIVATE SOURCE EXCERPT" }] },
    sourceHashes: ["sha256:private-source-hash"], generationMethod: "test",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
  Bun.env.LIFE_OS_VAULT_PATH = root; Bun.env.LIFE_OS_DATABASE_PATH = databasePath;
  Bun.env.LIFE_OS_GMAIL_ENABLED = "false"; Bun.env.LIFE_OS_IMESSAGE_ENABLED = "false";
  Bun.env.LIFE_OS_CALENDAR_ENABLED = "false"; Bun.env.LIFE_OS_TELEGRAM_ENABLED = "false";
  const snapshot = await compileUiWorkspace(new Date("2026-07-12T13:00:00.000Z"));
  const serialized = JSON.stringify(snapshot);
  expect(snapshot.mode).toBe("live");
  expect(snapshot.attention.find((queue) => queue.category === "reply")?.count).toBe(1);
  expect(snapshot.proposals[0]).toMatchObject({ approval: "required",
    preview: "Add one task to your Inbox" });
  for (const forbidden of ["provider-message-private", "private-source-hash", "PRIVATE SOURCE EXCERPT",
    "private@example.com", "prop_private_internal", "act_private_internal", "sha256:"]) {
    expect(serialized).not.toContain(forbidden);
  }
});
