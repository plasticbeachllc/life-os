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

  expect(store.getSchemaVersion()).toBe(21);
  expect(store.countRows("schema_migrations")).toBe(1);
});

test("rejects an incompatible prototype database with an explicit reset instruction", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-os-db-v7-"));
  const path = join(dir, "life-os.db");
  const db = new Database(path);
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?)")
    .run("2026-07-12T00:00:00.000Z");
  db.close();

  const store = new OperationalStore(path);
  expect(() => store.migrate()).toThrow(
    "prototype database schema 7 is incompatible with 21; delete the operational database and rebuild",
  );
  expect(store.getSchemaVersion()).toBe(7);
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
    effectType: "frontmatter_patch",
    effectPlan: { type: "frontmatter_patch", additions: {} },
    effectPlanHash: "sha256:test-plan",
    executorVersion: "frontmatter-patch-v1",
    lifecycleState: "applied",
    permissionClass: "green",
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

test("concurrent processes can verify the same current schema", async () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), "life-os-db-concurrent-")), "store.db");
  new OperationalStore(databasePath).migrate();
  const script = `import { OperationalStore } from ${JSON.stringify(join(import.meta.dir, "../src/db/store.ts"))}; new OperationalStore(${JSON.stringify(databasePath)}).migrate();`;
  const processes = Array.from({ length: 4 }, () => Bun.spawn(["bun", "-e", script], {
    stdout: "pipe", stderr: "pipe",
  }));
  const exits = await Promise.all(processes.map((process) => process.exited));
  expect(exits).toEqual([0, 0, 0, 0]);
});
