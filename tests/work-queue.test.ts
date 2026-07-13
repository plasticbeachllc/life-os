import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";
import type { EnqueueWorkInput } from "../src/work/contract";
import { WorkRepository } from "../src/work/repository";

test("work enqueue is idempotent and a lease has one concurrent owner", () => {
  const store = database("claim");
  const repository = new WorkRepository(store);
  const input = workInput();
  const first = repository.enqueue(input);
  const replay = repository.enqueue(input);

  expect(first.created).toBe(true);
  expect(replay.created).toBe(false);
  expect(replay.item.workId).toBe(first.item.workId);
  expect(store.countRows("work_items")).toBe(1);

  const claimed = repository.claimNext({
    workflow: "gmail_extraction", subjectSourceId: "account_internal",
    leaseOwner: "worker_a", leaseDurationMs: 60_000,
    now: new Date("2026-07-12T09:00:00.000Z"),
  });
  const raced = new WorkRepository(store).claimNext({
    workflow: "gmail_extraction", subjectSourceId: "account_internal",
    leaseOwner: "worker_b", leaseDurationMs: 60_000,
    now: new Date("2026-07-12T09:00:00.000Z"),
  });

  expect(claimed).toMatchObject({ state: "leased", leaseOwner: "worker_a", attempts: 1 });
  expect(raced).toBeUndefined();
});

test("a changed subject stales its old lease and creates one replacement", () => {
  const store = database("stale");
  const repository = new WorkRepository(store);
  const old = repository.enqueue(workInput()).item;
  repository.claimExact({
    workId: old.workId, leaseOwner: "worker_old", leaseDurationMs: 60_000,
    now: new Date("2026-07-12T09:00:00.000Z"),
  });
  const replacement = repository.enqueue({
    ...workInput(), sourceHash: "sha256:source-v2", containerHash: "sha256:thread-v2",
    now: "2026-07-12T09:00:10.000Z",
  });

  expect(replacement.created).toBe(true);
  expect(repository.get(old.workId)).toMatchObject({ state: "stale", errorCategory: "stale_source" });
  expect(repository.peekNext({
    workflow: "gmail_extraction", subjectSourceId: "account_internal",
    now: new Date("2026-07-12T09:00:10.000Z"),
  })?.workId).toBe(replacement.item.workId);
  expect(repository.status(new Date("2026-07-12T09:00:20.000Z")).byState).toEqual({
    pending: 1, leased: 0, completed: 0, stale: 1, failed: 0,
  });
});

test("expired leases recover until the bounded attempt limit", () => {
  const store = database("recovery");
  const repository = new WorkRepository(store);
  const work = repository.enqueue({ ...workInput(), maxAttempts: 2 }).item;
  repository.claimExact({
    workId: work.workId, leaseOwner: "worker_1", leaseDurationMs: 1_000,
    now: new Date("2026-07-12T09:00:00.000Z"),
  });
  expect(repository.recoverExpired(new Date("2026-07-12T09:00:02.000Z"))).toEqual({
    recovered: 1, failed: 0,
  });
  repository.claimExact({
    workId: work.workId, leaseOwner: "worker_2", leaseDurationMs: 1_000,
    now: new Date("2026-07-12T09:00:02.000Z"),
  });
  expect(repository.recoverExpired(new Date("2026-07-12T09:00:04.000Z"))).toEqual({
    recovered: 0, failed: 1,
  });
  expect(repository.get(work.workId)).toMatchObject({
    state: "failed", attempts: 2, errorCategory: "retry_exhausted",
  });
});

test("retry categories are bounded and status retains no work identities", () => {
  const store = database("privacy");
  const repository = new WorkRepository(store);
  const work = repository.enqueue({
    ...workInput(), maxAttempts: 1,
    // Runtime callers cannot smuggle transient source text through an extra property.
    rawText: "PRIVATE SOURCE EXCERPT",
  } as EnqueueWorkInput & { rawText: string }).item;
  repository.claimExact({
    workId: work.workId, leaseOwner: "worker", leaseDurationMs: 60_000,
    now: new Date("2026-07-12T09:00:00.000Z"),
  });
  const failed = repository.fail({
    workId: work.workId, leaseOwner: "worker", category: "provider_transient",
    retryable: true, now: new Date("2026-07-12T09:00:01.000Z"),
  });

  expect(failed).toMatchObject({ state: "failed", errorCategory: "retry_exhausted" });
  expect(repository.enqueue(workInput()).item).toMatchObject({
    workId: work.workId, state: "failed", attempts: 1,
  });
  const status = repository.status(new Date("2026-07-12T09:00:02.000Z"));
  const serializedStatus = JSON.stringify(status);
  expect(status).toEqual({
    total: 1,
    byState: { pending: 0, leased: 0, completed: 0, stale: 0, failed: 1 },
    byWorkflow: { gmail_extraction: 1, imessage_extraction: 0 },
    oldestPendingAgeSeconds: null,
  });
  expect(serializedStatus).not.toContain("account_internal");
  expect(serializedStatus).not.toContain("message_internal");
  expect(serializedStatus).not.toContain("sha256:");
  const db = store.open();
  try {
    expect(JSON.stringify(db.query("SELECT * FROM work_items").all())).not.toContain("PRIVATE SOURCE EXCERPT");
  } finally {
    db.close();
  }
});

function database(name: string): OperationalStore {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), `life-os-work-${name}-`)), "state.db"));
  store.migrate();
  return store;
}

function workInput(): EnqueueWorkInput {
  return {
    workflow: "gmail_extraction", subjectType: "gmail_message",
    subjectSourceId: "account_internal", subjectId: "message_internal",
    anchorId: "message_internal", sourceHash: "sha256:source-v1",
    containerHash: "sha256:thread-v1", reason: "source_delta",
    now: "2026-07-12T09:00:00.000Z",
  };
}
