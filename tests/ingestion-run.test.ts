import { expect, test } from "bun:test";
import { runIngestion } from "../src/integrations/ingestion-run";

test("ingestion lifecycle preserves the execute error when failure recording also fails", async () => {
  const primary = new Error("primary provider failure");
  await expect(runIngestion({
    start: () => {}, execute: async () => { throw primary; },
    complete: () => { throw new Error("must not run"); },
    fail: () => { throw new Error("terminal store unavailable"); },
  })).rejects.toBe(primary);
});

test("completion failure is primary and does not attempt a conflicting failed transition", async () => {
  let failed = false;
  const completion = new Error("completion write failed");
  await expect(runIngestion({
    start: async () => {}, execute: async () => ({ ingested: 1 }),
    complete: async () => { throw completion; }, fail: async () => { failed = true; },
  })).rejects.toBe(completion);
  expect(failed).toBeFalse();
});
