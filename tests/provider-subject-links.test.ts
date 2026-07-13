import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CalendarStore } from "../src/calendar/store";
import { OperationalStore } from "../src/db/store";
import { SourceEventRepository } from "../src/events/repository";
import { SourceSubjectLinkRepository } from "../src/events/subject-links";
import { GmailStore } from "../src/gmail/store";
import { normalizeGmailMessage } from "../src/gmail/normalizer";
import { sha256Text } from "../src/util/hashing";
import {
  linkCalendarEventToProject, linkCalendarEventToTask,
} from "../src/workflows/link-calendar-subject";
import {
  linkGmailThreadToPerson, linkGmailThreadToProject,
} from "../src/workflows/link-gmail-subject";

test("reviewed Gmail workflows link an ingested thread to canonical subjects", () => {
  const store = database("gmail");
  saveSubject(store, "person", "person_alex");
  saveSubject(store, "project", "project_launch");
  const gmail = new GmailStore(store);
  gmail.upsertAccount({
    accountId: "me", emailAddress: "user@example.com",
    selectionLabelId: "IMPORTANT_OR_SENT", now: "2026-07-12T13:00:00.000Z",
  });
  const message = normalizeGmailMessage({
    id: "PRIVATE_MESSAGE", threadId: "PRIVATE_THREAD", internalDate: "1783861200000",
    labelIds: ["IMPORTANT"], snippet: "Reviewed source",
  });
  gmail.saveMessageAndThread({
    accountId: "me", message, threadMessages: [message], now: "2026-07-12T13:00:00.000Z",
  });
  const person = linkGmailThreadToPerson({
    store, accountId: "me", sourceMessageId: "PRIVATE_MESSAGE", personId: "person_alex",
  });
  const project = linkGmailThreadToProject({
    store, accountId: "me", sourceMessageId: "PRIVATE_MESSAGE", projectId: "project_launch",
  });
  const event = new SourceEventRepository(store).listCurrent({ provider: "gmail", limit: 10 })[0]!;
  expect(new SourceSubjectLinkRepository(store).linkedSubjects(event.eventId)).toEqual([
    { type: "person", id: "person_alex" },
    { type: "project", id: "project_launch" },
  ]);
  expect(JSON.stringify([person, project])).not.toContain("PRIVATE_");
  expect(() => linkGmailThreadToPerson({
    store, accountId: "me", sourceMessageId: "missing", personId: "person_alex",
  })).toThrow("ingested selected Gmail message not found");
});

test("reviewed Calendar workflows scope links to one ingested primary event", () => {
  const store = database("calendar");
  saveSubject(store, "project", "project_launch");
  saveSubject(store, "task", "task_prepare");
  const calendar = new CalendarStore(store);
  calendar.upsertAccount({
    accountId: "me", calendarId: "PRIVATE_CALENDAR", now: "2026-07-12T13:00:00.000Z",
  });
  for (const [eventId, hour] of [["PRIVATE_EVENT_ONE", "14"], ["PRIVATE_EVENT_TWO", "15"]] as const) {
    calendar.saveEvent({
      accountId: "me", calendarId: "PRIVATE_CALENDAR", now: "2026-07-12T13:00:00.000Z",
      event: {
        eventId, status: "confirmed", summary: "Private summary",
        startAt: `2026-07-12T${hour}:00:00.000Z`, endAt: `2026-07-12T${hour}:30:00.000Z`,
        allDay: false, contentHash: sha256Text(eventId),
      },
    });
  }
  const project = linkCalendarEventToProject({
    store, accountId: "me", sourceEventId: "PRIVATE_EVENT_ONE", projectId: "project_launch",
  });
  const task = linkCalendarEventToTask({
    store, accountId: "me", sourceEventId: "PRIVATE_EVENT_ONE", taskId: "task_prepare",
  });
  const events = new SourceEventRepository(store).listCurrent({ provider: "calendar", limit: 10 });
  const links = new SourceSubjectLinkRepository(store);
  expect(links.linkedSubjects(events[0]!.eventId)).toEqual([
    { type: "project", id: "project_launch" },
    { type: "task", id: "task_prepare" },
  ]);
  expect(links.linkedSubjects(events[1]!.eventId)).toEqual([]);
  expect(JSON.stringify([project, task])).not.toContain("PRIVATE_");
});

function saveSubject(store: OperationalStore, type: "person" | "project" | "task", id: string): void {
  store.saveDerivedState({
    stateId: `state_${id}_v1`, stateType: `${type}_state`, entityId: id, stateVersion: 1,
    content: { entity_id: id }, sourceHashes: [sha256Text(id)], generationMethod: "test",
    dependencyHash: sha256Text(`dependency:${id}`), createdAt: "2026-07-12T12:00:00.000Z",
  });
}

function database(suffix: string): OperationalStore {
  const store = new OperationalStore(join(
    mkdtempSync(join(tmpdir(), `life-os-provider-subject-${suffix}-`)), "store.db",
  ));
  store.migrate();
  return store;
}
