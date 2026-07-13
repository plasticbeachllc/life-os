import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";
import { refreshAfterExtraction } from "../src/workflows/post-extraction-refresh";

test("post-extraction refresh is deterministic and performs no model, proposal, or action work", () => {
  const store = testStore();
  const now = new Date("2026-07-12T09:00:00.000Z");
  const first = refreshAfterExtraction({ store, now });
  const unchanged = refreshAfterExtraction({ store, now });

  expect(first).toEqual({
    status: "completed", attentionStateVersion: 1, chiefOfStaffStateVersion: 1,
  });
  expect(unchanged).toEqual(first);
  expect(store.getCurrentDerivedState("finding_attention_state")).toBeDefined();
  expect(store.getCurrentDerivedState("chief_of_staff_state")).toBeDefined();
  expect(store.countRows("model_calls")).toBe(0);
  expect(store.countRows("proposals")).toBe(0);
  expect(store.countRows("actions")).toBe(0);
});

test("projection refresh failure is sanitized and a later deterministic refresh recovers", () => {
  const store = testStore();
  const failed = refreshAfterExtraction({
    store, now: new Date("2026-07-12T09:00:00.000Z"),
    refresher: () => { throw new Error("private source detail must not escape"); },
  });

  expect(failed).toEqual({ status: "failed", errorCategory: "projection_refresh_failed" });
  expect(JSON.stringify(failed)).not.toContain("private source detail");
  expect(store.listCurrentDerivedStates("finding_attention_state")).toEqual([]);

  const recovered = refreshAfterExtraction({
    store, now: new Date("2026-07-12T09:05:00.000Z"),
  });
  expect(recovered).toEqual({
    status: "completed", attentionStateVersion: 1, chiefOfStaffStateVersion: 1,
  });
});

function testStore(): OperationalStore {
  const store = new OperationalStore(join(
    mkdtempSync(join(tmpdir(), "life-os-post-extraction-refresh-")), "store.db",
  ));
  store.migrate();
  return store;
}

