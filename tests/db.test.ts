import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";

test("migrates operational sqlite store", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-os-db-"));
  const store = new OperationalStore(join(dir, "life-os.db"));

  expect(store.getSchemaVersion()).toBeUndefined();

  store.migrate();

  expect(store.getSchemaVersion()).toBe(8);
  expect(store.countRows("schema_migrations")).toBe(1);
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
