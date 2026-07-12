import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { OperationalStore } from "../src/db/store";

test("migrates operational sqlite store", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-os-db-"));
  const store = new OperationalStore(join(dir, "life-os.db"));

  expect(store.getSchemaVersion()).toBeUndefined();

  store.migrate();

  expect(store.getSchemaVersion()).toBe(11);
  expect(store.countRows("schema_migrations")).toBe(1);
});

test("additively migrates an existing schema v7 database to combined provider schema v11", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-os-db-v7-"));
  const path = join(dir, "life-os.db");
  const db = new Database(path);
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?)")
    .run("2026-07-12T00:00:00.000Z");
  db.close();

  const store = new OperationalStore(path);
  store.migrate();

  expect(store.getSchemaVersion()).toBe(11);
  expect(store.countRows("schema_migrations")).toBe(2);
  expect(store.countRows("imessage_messages")).toBe(0);
  expect(store.countRows("calendar_events")).toBe(0);
});

test("records runs, actions, and action results", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-os-db-"));
  const store = new OperationalStore(join(dir, "life-os.db"));
  store.migrate();

  store.recordRun({
    runId: "run_test",
    workflow: "doctor",
    mode: "read-only",
    startedAt: "2026-07-12T12:00:00.000Z",
    status: "applied",
  });
  store.recordAction({
    actionId: "act_test",
    runId: "run_test",
    toolName: "write_audit_projection",
    lifecycleState: "applied",
    permissionClass: "green",
    arguments: { runId: "run_test" },
  });
  store.recordActionResult({
    actionId: "act_test",
    runId: "run_test",
    ok: true,
    message: "ok",
    filesModified: ["90 System/AI/Logs/2026-07-12.md"],
  });

  expect(store.countRows("runs")).toBe(1);
  expect(store.countRows("actions")).toBe(1);
  expect(store.countRows("action_results")).toBe(1);
});
