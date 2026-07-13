import { googleCalendarMaxResults, type CalendarApiEvent, type CalendarSourceAdapter } from "../adapters/calendar";
import { CalendarStore, type StoredCalendarEvent } from "../calendar/store";
import type { OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";
import { newId } from "../util/ids";
import { rebuildChiefOfStaffState } from "../state/chief-of-staff";
import { runIngestion } from "../integrations/ingestion-run";

export async function ingestCalendar(input: {
  adapter: CalendarSourceAdapter; store: OperationalStore; accountId: string;
  now?: Date; daysPast?: number; daysFuture?: number; maxPages?: number; maxEvents?: number; maxElapsedMs?: number;
}): Promise<{ runId: string; discovered: number; changed: number; unchanged: number; stateId: string;
  partial: boolean; resumed: boolean }> {
  input.store.migrate();
  const now = input.now ?? new Date();
  const runId = newId("run");
  const defaultTimeMin = new Date(now.getTime() - (input.daysPast ?? 1) * 86400000).toISOString();
  const defaultTimeMax = new Date(now.getTime() + (input.daysFuture ?? 30) * 86400000).toISOString();
  const maxPages = input.maxPages ?? 10;
  const maxEvents = input.maxEvents ?? 500;
  const maxElapsedMs = input.maxElapsedMs ?? 30_000;
  if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(maxEvents) || maxEvents < 1 || maxElapsedMs < 1) {
    throw new Error("calendar ingestion budgets must be positive");
  }
  const store = new CalendarStore(input.store);
  const events: CalendarApiEvent[] = [];
  let changed = 0; let unchanged = 0;
  return runIngestion({
    start: () => store.startRun(runId, input.accountId, now.toISOString()),
    execute: async () => {
      const calendar = await input.adapter.getPrimaryCalendar();
      store.upsertAccount({ accountId: input.accountId, calendarId: calendar.id,
        ...(calendar.timeZone ? { timezone: calendar.timeZone } : {}), now: now.toISOString() });
      const cursor = store.resumeCursor(input.accountId, calendar.id);
      const timeMin = cursor?.timeMin ?? defaultTimeMin;
      const timeMax = cursor?.timeMax ?? defaultTimeMax;
      let pageToken = cursor?.nextPageToken;
      let pages = 0;
      let partial = false;
      const startedAtMs = Date.now();
      do {
        if (pages >= maxPages || Date.now() - startedAtMs >= maxElapsedMs) { partial = true; break; }
        const page = await input.adapter.listEvents({ calendarId: calendar.id, timeMin, timeMax,
          ...(pageToken ? { pageToken } : {}),
          // maxEvents is a total-run budget, never a provider page-size request.
          maxResults: Math.min(googleCalendarMaxResults, maxEvents - events.length) });
        events.push(...page.events); pageToken = page.nextPageToken; pages += 1;
        if (pageToken && (events.length >= maxEvents || Date.now() - startedAtMs >= maxElapsedMs)) partial = true;
      } while (pageToken && !partial);
      if (partial && pageToken) {
        store.saveResumeCursor({ accountId: input.accountId, calendarId: calendar.id, timeMin, timeMax,
          nextPageToken: pageToken, now: new Date().toISOString() });
      } else {
        store.clearResumeCursor(input.accountId);
      }
      for (const source of events) {
        const event = normalizeEvent(source);
        if (store.currentHash(input.accountId, calendar.id, event.eventId) === event.contentHash) unchanged += 1;
        else { store.saveEvent({ accountId: input.accountId, calendarId: calendar.id, event,
          ...(source.updated ? { updated: source.updated } : {}), now: now.toISOString() }); changed += 1; }
      }
      const upcoming = store.listWindow(input.accountId, now.toISOString(), timeMax);
      const prior = input.store.getCurrentDerivedState("calendar_state", input.accountId);
      const sourceHash = sha256Value({ projectionVersion: "deterministic-calendar-v2", partial,
        events: upcoming.map((event) => event.contentHash) });
      const state = {
        stateId: newId("state"), stateType: "calendar_state", entityId: input.accountId,
        stateVersion: (prior?.stateVersion ?? 0) + 1,
        content: { as_of: now.toISOString(), window_end: timeMax, event_count: upcoming.length,
          partial,
          next_events: upcoming.slice(0, 20).map(({ contentHash: _, eventId: __, ...event }) => event) },
        sourceHashes: [sourceHash], generationMethod: "deterministic-calendar-v2", createdAt: now.toISOString(),
      };
      if (!prior?.sourceHashes.includes(sourceHash)) input.store.saveDerivedState(state);
      rebuildChiefOfStaffState({ store: input.store, now });
      store.markProcessed(input.accountId, calendar.id, upcoming);
      return { runId, discovered: events.length, changed, unchanged,
        stateId: prior?.sourceHashes.includes(sourceHash) ? prior.stateId : state.stateId,
        partial, resumed: Boolean(cursor) };
    },
    complete: (report) => store.finishRun({ runId, now: new Date().toISOString(), status: report.partial ? "partial" : "completed",
      discovered: report.discovered, changed: report.changed, unchanged: report.unchanged }),
    fail: (error) => store.finishRun({ runId, now: new Date().toISOString(), status: "failed",
      discovered: events.length, changed, unchanged,
      error: error instanceof Error ? error.message : String(error) }),
  });
}

function normalizeEvent(source: CalendarApiEvent): StoredCalendarEvent {
  const startAt = source.start?.dateTime ?? source.start?.date;
  const endAt = source.end?.dateTime ?? source.end?.date;
  if (!source.id || !startAt || !endAt) throw new Error("calendar event lacks stable ID or time range");
  const value = { eventId: source.id, status: source.status ?? "confirmed", summary: source.summary ?? "(untitled)",
    ...(source.location ? { location: source.location } : {}), startAt, endAt, allDay: Boolean(source.start?.date) };
  return { ...value, contentHash: sha256Value(value) };
}
