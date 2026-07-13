import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";
import type { AppendSourceEventInput } from "../src/events/contract";
import { SOURCE_EVENT_STREAM_VERSION, SourceEventRepository } from "../src/events/repository";
import { sha256Text } from "../src/util/hashing";

test("source event stream orders current events across every provider", () => {
  const store = database("all-providers");
  const events = new SourceEventRepository(store);
  for (const input of [
    event("calendar", "calendar_event", "system", "2026-07-12T12:04:00.000Z"),
    event("telegram", "message", "incoming", "2026-07-12T12:03:00.000Z"),
    event("gmail", "message", "outgoing", "2026-07-12T12:00:00.000Z"),
    event("obsidian", "canonical_note", "system", "2026-07-12T12:02:00.000Z"),
    event("imessage", "message", "incoming", "2026-07-12T12:01:00.000Z"),
  ] as const) events.append(input);

  const current = events.listCurrent({ limit: 20 });
  expect(current.map((item) => item.provider)).toEqual([
    "gmail", "imessage", "obsidian", "telegram", "calendar",
  ]);
  expect(current.every((item) => item.streamVersion === SOURCE_EVENT_STREAM_VERSION)).toBe(true);
  expect(events.listSince({ afterSequence: 2, limit: 20 }).map((item) => item.provider))
    .toEqual(["gmail", "obsidian", "imessage"]);
  expect(events.summary()).toEqual({
    total: 5,
    byProvider: { gmail: 1, imessage: 1, telegram: 1, calendar: 1, obsidian: 1 },
    byKind: { message: 3, canonical_note: 1, calendar_event: 1 },
    byDirection: { outgoing: 1, incoming: 2, system: 2 },
    earliestOccurredAt: "2026-07-12T12:00:00.000Z",
    latestOccurredAt: "2026-07-12T12:04:00.000Z",
  });
});

test("source event versions are immutable, idempotent, and expose only the current version", () => {
  const store = database("versions");
  const events = new SourceEventRepository(store);
  const firstInput = event("gmail", "message", "incoming", "2026-07-12T12:00:00.000Z");
  const first = events.append(firstInput);
  const replay = events.append(firstInput);
  const changed = events.append({
    ...firstInput, sourceVersionHash: sha256Text("version-2"),
    observedAt: "2026-07-12T14:00:00.000Z",
  });

  expect(first.created).toBe(true);
  expect(replay).toEqual({ event: first.event, created: false });
  expect(changed.event.previousEventId).toBe(first.event.eventId);
  expect(store.countRows("source_events")).toBe(2);
  expect(events.listCurrent({ limit: 10 })).toEqual([changed.event]);
});

test("causal windows include only current events through the selected event", () => {
  const store = database("causal");
  const events = new SourceEventRepository(store);
  const first = events.append(event(
    "gmail", "message", "incoming", "2026-07-12T12:00:00.000Z", "record-1", "thread-1",
  )).event;
  const second = events.append(event(
    "gmail", "message", "outgoing", "2026-07-12T12:01:00.000Z", "record-2", "thread-1",
  )).event;
  events.append(event(
    "gmail", "message", "incoming", "2026-07-12T12:02:00.000Z", "record-3", "thread-1",
  ));
  events.append(event(
    "gmail", "message", "incoming", "2026-07-12T11:59:00.000Z", "other-record", "thread-2",
  ));

  expect(events.causalWindow({ eventId: second.eventId }).map((item) => item.eventId))
    .toEqual([first.eventId, second.eventId]);
});

test("source event storage retains hashes and aggregates, not provider identities or content", () => {
  const store = database("privacy");
  const events = new SourceEventRepository(store);
  events.append({
    ...event("telegram", "message", "incoming", "2026-07-12T12:00:00.000Z"),
    sourceScopeId: "private-account-id", sourceRecordId: "private-message-id",
    containerId: "private-chat-id",
    rawText: "PRIVATE SOURCE EXCERPT",
  } as AppendSourceEventInput & { rawText: string });

  const db = store.open();
  try {
    const serialized = JSON.stringify(db.query("SELECT * FROM source_events").all());
    expect(serialized).not.toContain("private-account-id");
    expect(serialized).not.toContain("private-message-id");
    expect(serialized).not.toContain("private-chat-id");
    expect(serialized).not.toContain("PRIVATE SOURCE EXCERPT");
  } finally { db.close(); }
  expect(JSON.stringify(events.summary())).not.toContain("sha256:");
});

function event(
  provider: AppendSourceEventInput["provider"],
  eventKind: AppendSourceEventInput["eventKind"],
  direction: AppendSourceEventInput["direction"],
  occurredAt: string,
  sourceRecordId = `${provider}-record`,
  containerId = `${provider}-container`,
): AppendSourceEventInput {
  return {
    provider, eventKind, direction, sourceScopeId: `${provider}-scope`,
    sourceRecordId, containerId, sourceVersionHash: sha256Text(`${provider}:${sourceRecordId}:v1`),
    occurredAt, observedAt: "2026-07-12T13:00:00.000Z", contentAvailable: true,
  };
}

function database(suffix: string): OperationalStore {
  const store = new OperationalStore(join(
    mkdtempSync(join(tmpdir(), `life-os-source-events-${suffix}-`)), "store.db",
  ));
  store.migrate();
  return store;
}
