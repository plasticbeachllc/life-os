import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";
import { withRepositoryTransaction } from "../src/repositories/scope";
import { WorkRepository } from "../src/work/repository";

test("transaction repository composition uses one connection and rolls back every domain", () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-scope-")), "store.db"));
  store.migrate();
  let opens = 0;
  const counted = { open: () => { opens += 1; return store.open(); } };
  expect(() => withRepositoryTransaction(counted, ({ events, work }) => {
    const event = events.append({
      provider: "gmail", eventKind: "message", direction: "incoming",
      sourceScopeId: "account", sourceRecordId: "message", containerId: "thread",
      sourceVersionHash: "sha256:source", occurredAt: "2026-07-12T11:00:00.000Z",
      observedAt: "2026-07-12T12:00:00.000Z", contentAvailable: true,
    }).event;
    work.enqueue({
      workflow: "gmail_extraction", subjectType: "gmail_message",
      subjectSourceId: "account", subjectId: "message", anchorId: "message",
      sourceHash: "sha256:source", containerHash: "sha256:thread",
      streamEventId: event.eventId,
      reason: "source_delta", now: "2026-07-12T12:00:00.000Z",
      contractIdentity: "test:v1",
    });
    throw new Error("abort coordinated commit");
  })).toThrow("abort coordinated commit");
  expect(opens).toBe(1);
  expect(store.countRows("source_events")).toBe(0);
  expect(new WorkRepository(store).status().byState).toEqual({
    pending: 0, leased: 0, completed: 0, failed: 0, stale: 0,
  });
});
