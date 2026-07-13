import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleCalendarMaxResults, type CalendarSourceAdapter } from "../src/adapters/calendar";
import { CalendarStore } from "../src/calendar/store";
import { OperationalStore } from "../src/db/store";
import { ingestCalendar } from "../src/workflows/calendar-ingest";

class FakeCalendar implements CalendarSourceAdapter {
  events = [{ id: "event_1", summary: "Planning", location: "Room 2",
    start: { dateTime: "2026-07-13T09:00:00-04:00" }, end: { dateTime: "2026-07-13T10:00:00-04:00" } }];
  async getPrimaryCalendar() { return { id: "primary", timeZone: "America/New_York" }; }
  async listEvents() { return { events: this.events }; }
}

test("calendar ingestion is incremental and creates compact state without descriptions", async () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-calendar-")), "store.db"));
  const adapter = new FakeCalendar(); const now = new Date("2026-07-12T12:00:00Z");
  expect(await ingestCalendar({ adapter, store, accountId: "me", now })).toMatchObject({ discovered: 1, changed: 1, unchanged: 0 });
  expect(await ingestCalendar({ adapter, store, accountId: "me", now })).toMatchObject({ discovered: 1, changed: 0, unchanged: 1 });
  expect(store.countRows("calendar_events")).toBe(1);
  expect(store.countRows("calendar_event_versions")).toBe(1);
  expect(store.countRows("source_events")).toBe(1);
  expect(new CalendarStore(store).summary("me")).toMatchObject({
    configured: true, events: 1, versions: 1, unprocessed: 0, lastRunStatus: "completed",
  });
  expect(store.countRows("calendar_ingestion_runs")).toBe(2);
  const state = store.getCurrentDerivedState("calendar_state", "me");
  expect(state?.content.event_count).toBe(1);
  expect(JSON.stringify(state?.content)).not.toContain("description");
});

test("calendar edits create immutable versions", async () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-calendar-versions-")), "store.db"));
  const adapter = new FakeCalendar(); const now = new Date("2026-07-12T12:00:00Z");
  await ingestCalendar({ adapter, store, accountId: "me", now });
  adapter.events[0] = { ...adapter.events[0]!, summary: "Revised planning" };
  expect(await ingestCalendar({ adapter, store, accountId: "me", now })).toMatchObject({ changed: 1 });
  expect(store.countRows("calendar_events")).toBe(1);
  expect(store.countRows("calendar_event_versions")).toBe(2);
  expect(store.countRows("source_events")).toBe(2);
});

test("calendar ingestion records provider failures as terminal", async () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-calendar-failure-")), "store.db"));
  const adapter = new FakeCalendar();
  adapter.listEvents = async () => { throw new Error("calendar unavailable"); };
  await expect(ingestCalendar({ adapter, store, accountId: "me",
    now: new Date("2026-07-12T12:00:00Z") })).rejects.toThrow("calendar unavailable");
  expect(new CalendarStore(store).summary("me").lastRunStatus).toBe("failed");
});

test("calendar ingestion records primary-calendar failures as terminal", async () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-calendar-primary-failure-")), "store.db"));
  const adapter = new FakeCalendar();
  adapter.getPrimaryCalendar = async () => { throw new Error("calendar auth unavailable"); };
  await expect(ingestCalendar({ adapter, store, accountId: "me",
    now: new Date("2026-07-12T12:00:00Z") })).rejects.toThrow("calendar auth unavailable");
  expect(new CalendarStore(store).summary("me")).toMatchObject({
    configured: false, ingestionRuns: 1, lastRunStatus: "failed",
  });
});

test("calendar ingestion bounds pages and resumes the exact saved window", async () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-calendar-bounded-")), "store.db"));
  const calls: Array<{ pageToken?: string; timeMin: string; timeMax: string; maxResults?: number }> = [];
  const adapter: CalendarSourceAdapter = {
    getPrimaryCalendar: async () => ({ id: "primary" }),
    listEvents: async (input) => {
      calls.push(input);
      if (!input.pageToken) return { events: [{ id: "event_1", start: { dateTime: "2026-07-13T09:00:00Z" }, end: { dateTime: "2026-07-13T10:00:00Z" } }], nextPageToken: "page_2" };
      return { events: [{ id: "event_2", start: { dateTime: "2026-07-14T09:00:00Z" }, end: { dateTime: "2026-07-14T10:00:00Z" } }] };
    },
  };
  const first = await ingestCalendar({ adapter, store, accountId: "me", now: new Date("2026-07-12T12:00:00Z"), maxPages: 1, maxEvents: 1 });
  expect(first).toMatchObject({ partial: true, resumed: false, discovered: 1 });
  expect(new CalendarStore(store).summary("me").lastRunStatus).toBe("partial");
  const second = await ingestCalendar({ adapter, store, accountId: "me", now: new Date("2026-07-20T12:00:00Z"), maxPages: 1, maxEvents: 1 });
  expect(second).toMatchObject({ partial: false, resumed: true, discovered: 1 });
  expect(calls[1]).toMatchObject({ pageToken: "page_2", timeMin: calls[0]!.timeMin, timeMax: calls[0]!.timeMax, maxResults: 1 });
  expect(store.countRows("calendar_events")).toBe(2);
});

test("calendar ingestion records normalization failures after the run has started", async () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-calendar-normalization-failure-")), "store.db"));
  const adapter = new FakeCalendar();
  adapter.events = [{ id: "", summary: "Broken", location: "", start: { dateTime: "2026-07-13T09:00:00Z" }, end: { dateTime: "2026-07-13T10:00:00Z" } }];
  await expect(ingestCalendar({ adapter, store, accountId: "me" })).rejects.toThrow("stable ID");
  expect(new CalendarStore(store).summary("me")).toMatchObject({ ingestionRuns: 1, lastRunStatus: "failed" });
});

test("calendar processing remains scoped to the current calendar and caps provider pages", async () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-calendar-scope-")), "store.db"));
  store.migrate();
  const calendarStore = new CalendarStore(store);
  const event = { eventId: "shared_id", status: "confirmed", summary: "Planning", startAt: "2026-07-13T09:00:00Z",
    endAt: "2026-07-13T10:00:00Z", allDay: false, contentHash: "sha256:same" };
  calendarStore.saveEvent({ accountId: "me", calendarId: "former-primary", event, now: "2026-07-12T00:00:00Z" });
  calendarStore.saveEvent({ accountId: "me", calendarId: "current-primary", event, now: "2026-07-12T00:00:00Z" });
  calendarStore.markProcessed("me", "current-primary", [event]);
  const db = store.open();
  try {
    expect(db.query<{ last_processed_hash: string | null }, [string]>(
      "SELECT last_processed_hash FROM calendar_events WHERE calendar_id=? AND event_id='shared_id'",
    ).get("former-primary")!.last_processed_hash).toBeNull();
    expect(db.query<{ last_processed_hash: string | null }, [string]>(
      "SELECT last_processed_hash FROM calendar_events WHERE calendar_id=? AND event_id='shared_id'",
    ).get("current-primary")!.last_processed_hash).toBe("sha256:same");
  } finally { db.close(); }

  const pageSizes: number[] = [];
  const adapter: CalendarSourceAdapter = {
    getPrimaryCalendar: async () => ({ id: "primary" }),
    listEvents: async (input) => { pageSizes.push(input.maxResults ?? 0); return { events: [] }; },
  };
  await ingestCalendar({ adapter, store, accountId: "other", maxEvents: 5000 });
  expect(pageSizes).toEqual([googleCalendarMaxResults]);
});
