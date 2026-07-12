import type { CalendarApiEvent, CalendarSourceAdapter } from "../adapters/calendar";
import { CalendarStore, type StoredCalendarEvent } from "../calendar/store";
import type { OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";
import { newId } from "../util/ids";
import { rebuildChiefOfStaffState } from "../state/chief-of-staff";

export async function ingestCalendar(input: {
  adapter: CalendarSourceAdapter; store: OperationalStore; accountId: string;
  now?: Date; daysPast?: number; daysFuture?: number;
}): Promise<{ discovered: number; changed: number; unchanged: number; stateId: string }> {
  input.store.migrate();
  const now = input.now ?? new Date();
  const runId = newId("run");
  const timeMin = new Date(now.getTime() - (input.daysPast ?? 1) * 86400000).toISOString();
  const timeMax = new Date(now.getTime() + (input.daysFuture ?? 30) * 86400000).toISOString();
  const calendar = await input.adapter.getPrimaryCalendar();
  const store = new CalendarStore(input.store);
  store.upsertAccount({ accountId: input.accountId, calendarId: calendar.id,
    ...(calendar.timeZone ? { timezone: calendar.timeZone } : {}), now: now.toISOString() });
  store.startRun(runId, input.accountId, now.toISOString());
  const events: CalendarApiEvent[] = [];
  let pageToken: string | undefined;
  do {
    const page = await input.adapter.listEvents({ calendarId: calendar.id, timeMin, timeMax, ...(pageToken ? { pageToken } : {}) });
    events.push(...page.events); pageToken = page.nextPageToken;
  } while (pageToken);
  let changed = 0; let unchanged = 0;
  for (const source of events) {
    const event = normalizeEvent(source);
    if (store.currentHash(input.accountId, calendar.id, event.eventId) === event.contentHash) unchanged += 1;
    else { store.saveEvent({ accountId: input.accountId, calendarId: calendar.id, event,
      ...(source.updated ? { updated: source.updated } : {}), now: now.toISOString() }); changed += 1; }
  }
  const upcoming = store.listWindow(input.accountId, now.toISOString(), timeMax);
  const prior = input.store.getCurrentDerivedState("calendar_state", input.accountId);
  const sourceHash = sha256Value({ projectionVersion: "deterministic-calendar-v2",
    events: upcoming.map((event) => event.contentHash) });
  const state = {
    stateId: newId("state"), stateType: "calendar_state", entityId: input.accountId,
    stateVersion: (prior?.stateVersion ?? 0) + 1,
    content: { as_of: now.toISOString(), window_end: timeMax, event_count: upcoming.length,
      next_events: upcoming.slice(0, 20).map(({ contentHash: _, eventId: __, ...event }) => event) },
    sourceHashes: [sourceHash], generationMethod: "deterministic-calendar-v2", createdAt: now.toISOString(),
  };
  if (!prior?.sourceHashes.includes(sourceHash)) input.store.saveDerivedState(state);
  rebuildChiefOfStaffState({ store: input.store, now });
  store.markProcessed(input.accountId, upcoming);
  store.finishRun({ runId, now: now.toISOString(), status: "completed", discovered: events.length, changed, unchanged });
  return { discovered: events.length, changed, unchanged, stateId: prior?.sourceHashes.includes(sourceHash) ? prior.stateId : state.stateId };
}

function normalizeEvent(source: CalendarApiEvent): StoredCalendarEvent {
  const startAt = source.start?.dateTime ?? source.start?.date;
  const endAt = source.end?.dateTime ?? source.end?.date;
  if (!source.id || !startAt || !endAt) throw new Error("calendar event lacks stable ID or time range");
  const value = { eventId: source.id, status: source.status ?? "confirmed", summary: source.summary ?? "(untitled)",
    ...(source.location ? { location: source.location } : {}), startAt, endAt, allDay: Boolean(source.start?.date) };
  return { ...value, contentHash: sha256Value(value) };
}
