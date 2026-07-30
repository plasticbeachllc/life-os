import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ObsidianVault } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import type { ExtractionPilotReport } from "../src/workflows/run-one-extraction";
import {
  executeSyncProcess,
  SyncProcessRepository,
  syncProcessView,
} from "../src/workflows/sync-process";
import type { TodayRefreshReport } from "../src/workflows/refresh-today";

function fixture(): { store: OperationalStore; vault: ObsidianVault; root: string } {
  const root = mkdtempSync(join(tmpdir(), "life-os-sync-process-"));
  const store = new OperationalStore(join(root, "store.db"));
  store.migrate();
  return { store, vault: new ObsidianVault(root), root };
}

test("admits only one durable active sync process", () => {
  const { store } = fixture();
  const repository = new SyncProcessRepository(store);
  const first = repository.create({ gmail: 5, imessage: 5, model: "test",
    now: new Date("2026-07-29T12:00:00.000Z") });
  const second = repository.create({ gmail: 2, imessage: 0, model: "different",
    now: new Date("2026-07-29T12:00:01.000Z") });

  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(second.state.runId).toBe(first.state.runId);
  expect(second.state.requested).toEqual({ gmail: 5, imessage: 5 });
  expect(store.countRows("runs")).toBe(1);
});

test("runs ingestion and bounded extraction with sanitized durable progress", async () => {
  const { store, vault, root } = fixture();
  const repository = new SyncProcessRepository(store);
  const created = repository.create({ gmail: 2, imessage: 1, model: "test" }).state;
  const progress: ExtractionPilotReport = {
    requested: created.requested, completed: { gmail: 2, imessage: 1 },
    empty: { gmail: 0, imessage: 0 }, failed: { gmail: 0, imessage: 0 },
    classifications: { actionable: 1, reference_only: 2 }, itemCount: 3,
    relationCount: 0, unresolvedCount: 1, promptInjectionCount: 0, model: "test",
  };
  const refresh = async (): Promise<TodayRefreshReport> => ({
    refreshedAt: "2026-07-29T12:00:00.000Z",
    providers: [{ provider: "gmail", status: "ingested", changed: 2, unchanged: 0 }],
    state: { projected: 0, retired: 0, issues: [] }, modelCalls: 0,
  });
  const extract = async (input: Parameters<typeof import("../src/workflows/run-one-extraction").runExtractionPilot>[0]) => {
    await input.onProgress?.(progress);
    return progress;
  };

  const finished = await executeSyncProcess({
    store, vault, vaultPath: root, runId: created.runId, refresh, extract,
  });
  expect(finished).toMatchObject({ status: "completed", stage: "complete", extraction: progress });
  const view = syncProcessView(finished);
  expect(view).toMatchObject({
    processed: { gmail: 2, imessage: 1 }, findings: 3, unresolved: 1, canCancel: false,
  });
  expect(Object.keys(view!).sort()).toEqual([
    "canCancel", "completedAt", "createdAt", "failed", "findings", "processed", "providers",
    "requested", "stage", "status", "unresolved", "updatedAt",
  ]);
  expect(JSON.stringify(view)).not.toContain(created.runId);
  expect(JSON.stringify(view)).not.toContain("classifications");
  expect(JSON.stringify(view)).not.toContain("\"model\"");
  expect(JSON.stringify(repository.get())).not.toContain("changed");
});

test("cancellation is observed between extraction items", async () => {
  const { store, vault, root } = fixture();
  const repository = new SyncProcessRepository(store);
  const created = repository.create({ gmail: 5, imessage: 0, model: "test" }).state;
  let observedStop = false;
  const refresh = async (): Promise<TodayRefreshReport> => ({
    refreshedAt: new Date().toISOString(), providers: [], state: { projected: 0, retired: 0, issues: [] },
    modelCalls: 0,
  });
  const extract = async (input: Parameters<typeof import("../src/workflows/run-one-extraction").runExtractionPilot>[0]) => {
    repository.requestCancel();
    observedStop = await input.shouldStop?.() ?? false;
    return {
      requested: { gmail: 5, imessage: 0 }, completed: { gmail: 0, imessage: 0 },
      empty: { gmail: 0, imessage: 0 }, failed: { gmail: 0, imessage: 0 },
      classifications: {}, itemCount: 0, relationCount: 0, unresolvedCount: 0,
      promptInjectionCount: 0, model: "test",
    };
  };
  const finished = await executeSyncProcess({
    store, vault, vaultPath: root, runId: created.runId, refresh, extract,
  });
  expect(observedStop).toBe(true);
  expect(finished?.status).toBe("cancelled");
});

test("private provider failures are categorized and never persisted", async () => {
  const { store, vault, root } = fixture();
  const repository = new SyncProcessRepository(store);
  const created = repository.create({ gmail: 1, imessage: 0, model: "test" }).state;
  const secret = "private-message-body-and-provider-id";
  const failed = await executeSyncProcess({
    store, vault, vaultPath: root, runId: created.runId,
    refresh: async () => { throw new Error(secret); },
  });
  expect(failed).toMatchObject({ status: "failed", errorCategory: "ingestion" });
  expect(JSON.stringify(repository.get())).not.toContain(secret);
  const db = store.open();
  try {
    expect(JSON.stringify(db.query("SELECT * FROM runs").all())).not.toContain(secret);
  } finally {
    db.close();
  }
});

test("an abandoned active run is explicitly interrupted before a replacement is created", () => {
  const { store } = fixture();
  const repository = new SyncProcessRepository(store);
  const first = repository.create({ gmail: 1, imessage: 1, model: "test",
    now: new Date("2026-07-29T10:00:00.000Z") }).state;
  repository.begin(first.runId, new Date("2026-07-29T10:00:01.000Z"));
  expect(repository.interrupt(first.runId, new Date("2026-07-29T10:00:02.000Z"))?.status)
    .toBe("interrupted");
  const replacement = repository.create({ gmail: 1, imessage: 0, model: "test",
    now: new Date("2026-07-29T10:00:03.000Z") });
  expect(replacement.created).toBe(true);
  expect(replacement.state.runId).not.toBe(first.runId);
  const db = store.open();
  try {
    expect(db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE run_id = ?")
      .get(first.runId)?.status).toBe("interrupted");
  } finally {
    db.close();
  }
});
