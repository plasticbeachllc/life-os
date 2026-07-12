import type { OperationalStore } from "../db/store";

export interface StoredCalendarEvent {
  eventId: string; status: string; summary: string; location?: string;
  startAt: string; endAt: string; allDay: boolean; contentHash: string;
}

export class CalendarStore {
  constructor(private readonly store: OperationalStore) {}

  upsertAccount(input: { accountId: string; calendarId: string; timezone?: string; now: string }): void {
    const db = this.store.open();
    try {
      db.query(`INSERT INTO calendar_accounts (account_id, calendar_id, timezone, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET calendar_id=excluded.calendar_id,
        timezone=excluded.timezone, updated_at=excluded.updated_at`)
        .run(input.accountId, input.calendarId, input.timezone ?? null, input.now, input.now);
    } finally { db.close(); }
  }

  startRun(runId: string, accountId: string, now: string): void {
    const db = this.store.open(); try {
      db.query("INSERT INTO calendar_ingestion_runs (ingestion_run_id,account_id,started_at,status) VALUES (?,?,?,'running')")
        .run(runId, accountId, now);
    } finally { db.close(); }
  }
  finishRun(input: { runId: string; now: string; status: "completed" | "failed"; discovered: number;
    changed: number; unchanged: number; error?: string }): void {
    const db = this.store.open(); try {
      db.query(`UPDATE calendar_ingestion_runs SET completed_at=?,status=?,discovered_count=?,changed_count=?,
        unchanged_count=?,error=? WHERE ingestion_run_id=?`).run(input.now, input.status, input.discovered,
        input.changed, input.unchanged, input.error ?? null, input.runId);
    } finally { db.close(); }
  }

  currentHash(accountId: string, calendarId: string, eventId: string): string | undefined {
    const db = this.store.open();
    try {
      return db.query<{ content_hash: string }, [string, string, string]>(
        "SELECT content_hash FROM calendar_events WHERE account_id=? AND calendar_id=? AND event_id=?",
      ).get(accountId, calendarId, eventId)?.content_hash;
    } finally { db.close(); }
  }

  saveEvent(input: { accountId: string; calendarId: string; event: StoredCalendarEvent; updated?: string; now: string }): void {
    const db = this.store.open();
    try {
      db.query(`INSERT INTO calendar_events (account_id, calendar_id, event_id, status, summary,
        location, start_at, end_at, all_day, updated_at, content_hash, first_ingested_at, last_ingested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, calendar_id, event_id) DO UPDATE SET status=excluded.status,
        summary=excluded.summary, location=excluded.location, start_at=excluded.start_at,
        end_at=excluded.end_at, all_day=excluded.all_day, updated_at=excluded.updated_at,
        content_hash=excluded.content_hash, last_ingested_at=excluded.last_ingested_at`)
        .run(input.accountId, input.calendarId, input.event.eventId, input.event.status,
          input.event.summary, input.event.location ?? null, input.event.startAt, input.event.endAt,
          input.event.allDay ? 1 : 0, input.updated ?? null, input.event.contentHash, input.now, input.now);
    } finally { db.close(); }
  }

  listWindow(accountId: string, start: string, end: string): StoredCalendarEvent[] {
    const db = this.store.open();
    try {
      return db.query<any, [string, string, string]>(`SELECT event_id, status, summary, location,
        start_at, end_at, all_day, content_hash FROM calendar_events
        WHERE account_id=? AND status <> 'cancelled' AND end_at > ? AND start_at < ? ORDER BY start_at`,
      ).all(accountId, start, end).map((row) => ({ eventId: row.event_id, status: row.status,
        summary: row.summary, ...(row.location ? { location: row.location } : {}), startAt: row.start_at,
        endAt: row.end_at, allDay: Boolean(row.all_day), contentHash: row.content_hash }));
    } finally { db.close(); }
  }
  markProcessed(accountId: string, events: StoredCalendarEvent[]): void {
    const db = this.store.open(); try {
      const update = db.query(`UPDATE calendar_events SET last_processed_hash=?
        WHERE account_id=? AND event_id=? AND content_hash=?`);
      db.transaction(() => { for (const event of events) update.run(event.contentHash, accountId, event.eventId, event.contentHash); })();
    } finally { db.close(); }
  }

  summary(accountId: string): { configured: boolean; events: number; unprocessed: number } {
    const db = this.store.open();
    try {
      const configured = Boolean(db.query("SELECT 1 FROM calendar_accounts WHERE account_id=?").get(accountId));
      const counts = db.query<{ count: number; unprocessed: number }, [string]>(`SELECT COUNT(*) count,
        COALESCE(SUM(CASE WHEN last_processed_hash IS NULL THEN 1 ELSE 0 END),0) unprocessed
        FROM calendar_events WHERE account_id=?`).get(accountId);
      return { configured, events: counts?.count ?? 0, unprocessed: counts?.unprocessed ?? 0 };
    } finally { db.close(); }
  }
}
