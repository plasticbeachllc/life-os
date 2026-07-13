import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";
import type { AppendSourceEventInput } from "../src/events/contract";
import { SourceEventRepository } from "../src/events/repository";
import { SourceSubjectLinkRepository } from "../src/events/subject-links";
import { sha256Text } from "../src/util/hashing";
import {
  assertSourceSubjectContextCurrent, sourceSubjectContextCandidate,
} from "../src/context/source-subjects";

test("reviewed canonical subjects create a causal window across providers", () => {
  const store = database("cross-provider");
  saveSubject(store, "person", "person_alex");
  const events = new SourceEventRepository(store);
  const gmail = events.append(event(
    "gmail", "2026-07-12T12:00:00.000Z", "gmail-1", "gmail-thread",
  )).event;
  const messages = events.append(event(
    "imessage", "2026-07-12T12:01:00.000Z", "message-1", "message-chat",
  )).event;
  const unrelated = events.append(event(
    "calendar", "2026-07-12T11:59:00.000Z", "calendar-1", "calendar-event",
    "calendar_event", "system",
  )).event;
  const later = events.append(event(
    "gmail", "2026-07-12T12:02:00.000Z", "gmail-2", "gmail-thread",
  )).event;
  const links = new SourceSubjectLinkRepository(store);
  links.link({ eventId: gmail.eventId, subject: { type: "person", id: "person_alex" }, basis: "reviewed" });
  links.link({ eventId: messages.eventId, subject: { type: "person", id: "person_alex" }, basis: "reviewed" });

  expect(links.linkedSubjects(messages.eventId)).toEqual([{ type: "person", id: "person_alex" }]);
  expect(links.causalWindow({ eventId: messages.eventId }).map((item) => item.eventId))
    .toEqual([gmail.eventId, messages.eventId]);
  expect(links.causalWindow({ eventId: later.eventId }).map((item) => item.eventId))
    .toEqual([gmail.eventId, messages.eventId, later.eventId]);
  expect(links.causalWindow({ eventId: later.eventId }).map((item) => item.eventId))
    .not.toContain(unrelated.eventId);
});

test("subject links require a current event and current canonical state", () => {
  const store = database("validation");
  const events = new SourceEventRepository(store);
  const originalInput = event("gmail", "2026-07-12T12:00:00.000Z", "gmail-1", "thread-1");
  const original = events.append(originalInput).event;
  const current = events.append({
    ...originalInput, sourceVersionHash: sha256Text("changed"),
    observedAt: "2026-07-12T13:10:00.000Z",
  }).event;
  const links = new SourceSubjectLinkRepository(store);
  expect(() => links.link({
    eventId: current.eventId, subject: { type: "person", id: "person_missing" }, basis: "reviewed",
  })).toThrow("current canonical subject state not found");
  saveSubject(store, "person", "person_alex");
  expect(() => links.link({
    eventId: original.eventId, subject: { type: "person", id: "person_alex" }, basis: "reviewed",
  })).toThrow("current source event not found");
  expect(() => links.causalWindow({ eventId: current.eventId }))
    .toThrow("no current canonical subject link");
});

test("a changed reviewed record invalidates its subject link", () => {
  const store = database("changed-validation");
  saveSubject(store, "task", "task_review");
  const events = new SourceEventRepository(store);
  const originalInput = event("gmail", "2026-07-12T12:00:00.000Z", "gmail-1", "thread-1");
  const original = events.append(originalInput).event;
  const links = new SourceSubjectLinkRepository(store);
  links.link({
    eventId: original.eventId, subject: { type: "task", id: "task_review" }, basis: "reviewed",
  });
  expect(links.linkedSubjects(original.eventId)).toEqual([{ type: "task", id: "task_review" }]);
  const revised = events.append({
    ...originalInput, sourceVersionHash: sha256Text("revised-record"),
    observedAt: "2026-07-12T13:10:00.000Z",
  }).event;
  expect(links.linkedSubjects(revised.eventId)).toEqual([]);
});

test("revocation removes traversal authority and storage retains no provider identity", () => {
  const store = database("privacy-revoke");
  saveSubject(store, "project", "project_private");
  const source = new SourceEventRepository(store).append({
    ...event("telegram", "2026-07-12T12:00:00.000Z", "PRIVATE_MESSAGE", "PRIVATE_CHAT"),
    sourceScopeId: "PRIVATE_ACCOUNT",
  }).event;
  const links = new SourceSubjectLinkRepository(store);
  const link = links.link({
    eventId: source.eventId, subject: { type: "project", id: "project_private" }, basis: "reviewed",
    createdAt: "2026-07-12T13:00:00.000Z",
  });
  expect(links.revoke({ linkId: link.linkId, revokedAt: "2026-07-12T13:01:00.000Z" })).toBe(true);
  expect(links.linkedSubjects(source.eventId)).toEqual([]);
  const db = store.open();
  try {
    const stored = JSON.stringify(db.query("SELECT * FROM source_subject_links").all());
    expect(stored).not.toContain("PRIVATE_ACCOUNT");
    expect(stored).not.toContain("PRIVATE_MESSAGE");
    expect(stored).not.toContain("PRIVATE_CHAT");
  } finally { db.close(); }
});

test("bounded context exposes sanitized linked history and rejects changed dependencies", () => {
  const store = database("context");
  saveSubject(store, "project", "project_launch");
  const events = new SourceEventRepository(store);
  const gmail = events.append(event(
    "gmail", "2026-07-12T12:00:00.000Z", "PRIVATE_GMAIL_ID", "PRIVATE_THREAD_ID",
  )).event;
  const calendar = events.append(event(
    "calendar", "2026-07-12T12:02:00.000Z", "PRIVATE_CALENDAR_ID", "PRIVATE_EVENT_ID",
    "calendar_event", "system",
  )).event;
  const links = new SourceSubjectLinkRepository(store);
  links.link({ eventId: gmail.eventId, subject: { type: "project", id: "project_launch" }, basis: "reviewed" });
  const calendarLink = links.link({
    eventId: calendar.eventId, subject: { type: "project", id: "project_launch" }, basis: "reviewed",
  });
  const candidate = sourceSubjectContextCandidate({ store, eventId: calendar.eventId });
  expect(candidate.category).toBe("recent_change");
  expect(candidate.retrievalLevel).toBe(1);
  expect(candidate.content).toMatchObject({
    context_kind: "validated_source_subject_history",
    linked_subjects: [{ type: "project", id: "project_launch" }],
    recent_events: [{ provider: "gmail" }, { provider: "calendar" }],
  });
  expect(JSON.stringify(candidate.content)).not.toContain("PRIVATE_");
  expect(() => assertSourceSubjectContextCurrent(store, [candidate])).not.toThrow();
  links.revoke({ linkId: calendarLink.linkId });
  expect(() => assertSourceSubjectContextCurrent(store, [candidate]))
    .toThrow("validated source subject context changed");
});

test("an association added after preparation invalidates an empty subject snapshot", () => {
  const store = database("context-added-link");
  saveSubject(store, "person", "person_alex");
  const sourceEvent = new SourceEventRepository(store).append(
    event("gmail", "2026-07-12T12:00:00.000Z", "record", "thread"),
  ).event;
  const prepared = sourceSubjectContextCandidate({ store, eventId: sourceEvent.eventId });
  expect(prepared.content).toMatchObject({ linked_subjects: [], recent_events: [] });
  new SourceSubjectLinkRepository(store).link({
    eventId: sourceEvent.eventId, subject: { type: "person", id: "person_alex" }, basis: "reviewed",
  });
  expect(() => assertSourceSubjectContextCurrent(store, [prepared]))
    .toThrow("validated source subject context changed");
});

function event(
  provider: AppendSourceEventInput["provider"], occurredAt: string,
  sourceRecordId: string, containerId: string,
  eventKind: AppendSourceEventInput["eventKind"] = "message",
  direction: AppendSourceEventInput["direction"] = "incoming",
): AppendSourceEventInput {
  return {
    provider, eventKind, direction, sourceScopeId: `${provider}-scope`,
    sourceRecordId, containerId, sourceVersionHash: sha256Text(`${provider}:${sourceRecordId}:v1`),
    occurredAt, observedAt: "2026-07-12T13:00:00.000Z", contentAvailable: true,
  };
}


function saveSubject(store: OperationalStore, type: "person" | "project" | "task", id: string): void {
  store.saveDerivedState({
    stateId: `state_${id}_v1`, stateType: `${type}_state`, entityId: id, stateVersion: 1,
    content: { entity_id: id }, sourceHashes: [sha256Text(id)],
    generationMethod: "test", builderName: "test", builderVersion: "v1",
    dependencyHash: sha256Text(`dependency:${id}`), createdAt: "2026-07-12T11:00:00.000Z",
  });
}

function database(suffix: string): OperationalStore {
  const store = new OperationalStore(join(
    mkdtempSync(join(tmpdir(), `life-os-source-subject-${suffix}-`)), "store.db",
  ));
  store.migrate();
  return store;
}
