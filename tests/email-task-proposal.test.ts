import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObsidianVault } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import { proposeEmailExtractionTask } from "../src/workflows/email-task-proposal";
import { applyEmailTaskProposal } from "../src/tools/append-email-task";
import { rebuildState } from "../src/workflows/rebuild-state";

function fixture(owner = "user") {
  const root = mkdtempSync(join(tmpdir(), "life-os-email-task-")); mkdirSync(join(root, "00 Inbox"), { recursive: true });
  writeFileSync(join(root, "00 Inbox/Inbox.md"), "# Inbox\n");
  mkdirSync(join(root, "90 System/AI"), { recursive: true });
  for (const file of ["Constitution.md", "Permissions.md", "Schemas.md", "Agent.md"]) {
    writeFileSync(join(root, "90 System/AI", file), `# ${file}\n`);
  }
  writeFileSync(join(root, "90 System/AI/permissions.toml"), "[actions.create_task]\nenabled = true\nmode = \"proposal\"\n");
  const store = new OperationalStore(join(root, "store.db")); store.migrate(); const db = store.open();
  try {
    db.query("INSERT INTO gmail_accounts VALUES (?, ?, 'IMPORTANT', NULL, ?, ?)").run("me", "user@example.com", "now", "now");
    db.query(`INSERT INTO gmail_messages (account_id,message_id,thread_id,internal_date,to_addresses_json,cc_addresses_json,
      selected_important,content_hash,current_version_hash,ingestion_state,first_ingested_at,last_ingested_at)
      VALUES ('me','m1','t1','1','[]','[]',1,'sha256:source','sha256:source','extracted','now','now')`).run();
    store.recordModelCall({ callId: "call_test", workflow: "gmail_extraction", taskType: "subscription_email_extraction",
      model: "test", promptVersion: "v1", sourceHash: "sha256:source", contextHash: "sha256:context",
      cached: false, startedAt: "now", completedAt: "now", status: "completed" });
    db.query(`INSERT INTO gmail_extractions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "extract_test", "me", "m1", "sha256:source", "sha256:thread", "call_test", "actionable",
      JSON.stringify({ summary: "test", items: [{ kind: "open_loop", statement: "Cancel trial", owner,
        dueDate: "2026-07-15", evidenceIds: ["e1"], confidence: 1, ambiguities: [] }], unresolved: [] }),
      "v1", "s1", "p1", "test", "now");
  } finally { db.close(); }
  return { vault: new ObsidianVault(root), store, root };
}

test("selected actionable email item creates a fixed-target proposal without writing", async () => {
  const { vault, store, root } = fixture();
  const proposal = await proposeEmailExtractionTask({ extractionId: "extract_test", itemIndex: 0, vault, store });
  expect(proposal.targetPath).toBe("00 Inbox/Inbox.md"); expect(proposal.toolName).toBe("append_email_task");
  expect(proposal.arguments.taskLine).toBe("- [ ] Cancel trial 📅 2026-07-15");
  expect(await Bun.file(join(root, "00 Inbox/Inbox.md")).text()).toBe("# Inbox\n");
});

test("email task proposal rejects items not owned by the user", async () => {
  const { vault, store } = fixture("other");
  expect(proposeEmailExtractionTask({ extractionId: "extract_test", itemIndex: 0, vault, store }))
    .rejects.toThrow("user-owned actionable");
});

test("approved email task applies and rebuilds with stable ID and provenance", async () => {
  const { vault, store, root } = fixture();
  const proposal = await proposeEmailExtractionTask({ extractionId: "extract_test", itemIndex: 0, vault, store });
  store.approveProposalAction(proposal.proposalId, proposal.actionId, new Date().toISOString());
  await applyEmailTaskProposal({ proposalId: proposal.proposalId, vault, store, backupRoot: join(root, "backups") });
  const report = await rebuildState({ vault, store });
  expect(report.issues).toEqual([]); expect(report.tasks).toBe(1);
  const task = store.listCurrentDerivedStates("task_state")[0]!;
  expect(task.content.source).toBe("extract_test");
});
