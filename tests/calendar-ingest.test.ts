import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CalendarSourceAdapter } from "../src/adapters/calendar";
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
