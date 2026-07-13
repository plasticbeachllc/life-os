import type { OperationalStore } from "../db/store";
import { sha256Text, sha256Value } from "../util/hashing";
import type {
  AppendSourceEventInput, SourceEvent, SourceEventDirection, SourceEventKind,
  SourceEventProvider, SourceEventSummary,
} from "./contract";
import { sourceEventProviders } from "./contract";

export const SOURCE_EVENT_STREAM_VERSION = "source-event-stream-v1";

export interface SourceEventOrderPosition {
  provider: SourceEventProvider;
  sourceRecordId: string;
  occurredAt: string;
}

export function compareSourceEventOrder(
  left: SourceEventOrderPosition, right: SourceEventOrderPosition,
): number {
  const occurred = iso(left.occurredAt, "occurredAt").localeCompare(iso(right.occurredAt, "occurredAt"));
  if (occurred !== 0) return occurred;
  return opaqueHash(left.provider, "record", left.sourceRecordId)
    .localeCompare(opaqueHash(right.provider, "record", right.sourceRecordId));
}

type DatabaseConnection = ReturnType<OperationalStore["open"]>;

interface SourceEventRow {
  event_id: string;
  stream_sequence: number;
  provider: SourceEventProvider;
  event_kind: SourceEventKind;
  direction: SourceEventDirection;
  source_scope_hash: string;
  source_record_hash: string;
  container_hash: string;
  source_version_hash: string;
  previous_event_id: string | null;
  occurred_at: string;
  observed_at: string;
  content_available: number;
  stream_version: string;
}

export function appendSourceEventInTransaction(
  db: DatabaseConnection, input: AppendSourceEventInput,
): { event: SourceEvent; created: boolean } {
  const normalized = normalizeInput(input);
  const sourceScopeHash = opaqueHash(input.provider, "scope", input.sourceScopeId);
  const sourceRecordHash = opaqueHash(input.provider, "record", input.sourceRecordId);
  const containerHash = opaqueHash(input.provider, "container", input.containerId);
  const identity = {
    provider: input.provider, sourceScopeHash, sourceRecordHash,
    sourceVersionHash: input.sourceVersionHash,
  };
  const eventId = `event_${sha256Value(identity).slice("sha256:".length)}`;
  const existing = byId(db, eventId);
  if (existing) return { event: existing, created: false };
  const previousEventId = db.query<{ event_id: string }, [string, string, string]>(`
    SELECT event_id FROM source_events
    WHERE provider = ? AND source_scope_hash = ? AND source_record_hash = ?
    ORDER BY stream_sequence DESC LIMIT 1
  `).get(input.provider, sourceScopeHash, sourceRecordHash)?.event_id;
  db.query(`
    INSERT INTO source_events (
      event_id, provider, event_kind, direction, source_scope_hash, source_record_hash,
      container_hash, source_version_hash, previous_event_id, occurred_at, observed_at,
      content_available, stream_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId, input.provider, input.eventKind, input.direction, sourceScopeHash,
    sourceRecordHash, containerHash, input.sourceVersionHash, previousEventId ?? null,
    normalized.occurredAt, normalized.observedAt, input.contentAvailable ? 1 : 0,
    SOURCE_EVENT_STREAM_VERSION,
  );
  return { event: byId(db, eventId)!, created: true };
}

export function currentSourceEventInTransaction(db: DatabaseConnection, input: {
  provider: SourceEventProvider; sourceScopeId: string; sourceRecordId: string;
}): SourceEvent | undefined {
  const scopeHash = opaqueHash(input.provider, "scope", input.sourceScopeId);
  const recordHash = opaqueHash(input.provider, "record", input.sourceRecordId);
  const row = db.query<SourceEventRow, [SourceEventProvider, string, string]>(`
    SELECT event.* FROM source_events event
    WHERE event.provider = ? AND event.source_scope_hash = ? AND event.source_record_hash = ?
    ORDER BY event.stream_sequence DESC LIMIT 1
  `).get(input.provider, scopeHash, recordHash);
  return row ? sourceEvent(row) : undefined;
}

export function requireCurrentSourceEventIdInTransaction(db: DatabaseConnection, input: {
  provider: SourceEventProvider; sourceScopeId: string; sourceRecordId: string;
}): string {
  const event = currentSourceEventInTransaction(db, input);
  if (!event) throw new Error("source event is missing for provider work");
  return event.eventId;
}

export function currentSourceEventForContainerInTransaction(db: DatabaseConnection, input: {
  provider: SourceEventProvider; sourceScopeId: string; containerId: string;
}): SourceEvent | undefined {
  const scopeHash = opaqueHash(input.provider, "scope", input.sourceScopeId);
  const containerHash = opaqueHash(input.provider, "container", input.containerId);
  const row = db.query<SourceEventRow, [SourceEventProvider, string, string]>(`
    SELECT event.* FROM source_events event
    WHERE event.provider = ? AND event.source_scope_hash = ? AND event.container_hash = ?
      AND NOT EXISTS (
        SELECT 1 FROM source_events newer
        WHERE newer.provider = event.provider
          AND newer.source_scope_hash = event.source_scope_hash
          AND newer.source_record_hash = event.source_record_hash
          AND newer.stream_sequence > event.stream_sequence
      )
    ORDER BY event.occurred_at DESC, event.source_record_hash DESC, event.event_id DESC LIMIT 1
  `).get(input.provider, scopeHash, containerHash);
  return row ? sourceEvent(row) : undefined;
}

export class SourceEventRepository {
  constructor(private readonly store: OperationalStore) {}

  append(input: AppendSourceEventInput): { event: SourceEvent; created: boolean } {
    const db = this.store.open();
    try {
      return db.transaction(() => appendSourceEventInTransaction(db, input))();
    } finally { db.close(); }
  }

  listCurrent(input: { limit: number; provider?: SourceEventProvider }): SourceEvent[] {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
      throw new Error("source event limit must be between 1 and 1000");
    }
    const db = this.store.open();
    try {
      const rows = input.provider
        ? db.query<SourceEventRow, [SourceEventProvider, number]>(`${currentEventsSql()}
            AND event.provider = ?
            ORDER BY event.occurred_at, event.provider, event.source_record_hash, event.event_id LIMIT ?`)
          .all(input.provider, input.limit)
        : db.query<SourceEventRow, [number]>(`${currentEventsSql()}
            ORDER BY event.occurred_at, event.provider, event.source_record_hash, event.event_id LIMIT ?`)
          .all(input.limit);
      return rows.map(sourceEvent);
    } finally { db.close(); }
  }

  listSince(input: {
    afterSequence?: number; limit: number; provider?: SourceEventProvider;
  }): SourceEvent[] {
    const after = input.afterSequence ?? 0;
    if (!Number.isInteger(after) || after < 0
      || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
      throw new Error("source event replay bounds are invalid");
    }
    const db = this.store.open();
    try {
      const rows = input.provider
        ? db.query<SourceEventRow, [number, SourceEventProvider, number]>(`
            SELECT * FROM source_events WHERE stream_sequence > ? AND provider = ?
            ORDER BY stream_sequence LIMIT ?`).all(after, input.provider, input.limit)
        : db.query<SourceEventRow, [number, number]>(`
            SELECT * FROM source_events WHERE stream_sequence > ?
            ORDER BY stream_sequence LIMIT ?`).all(after, input.limit);
      return rows.map(sourceEvent);
    } finally { db.close(); }
  }

  causalWindow(input: {
    eventId: string; before?: number;
  }): SourceEvent[] {
    const before = input.before ?? 20;
    if (!Number.isInteger(before) || before < 0 || before > 100) {
      throw new Error("causal source event window must be between 0 and 100");
    }
    const db = this.store.open();
    try {
      const target = byId(db, input.eventId);
      if (!target || !isCurrent(db, target)) throw new Error("current source event not found");
      const rows = db.query<SourceEventRow, [string, string, string, string, string, string, number]>(`
        SELECT event.* FROM source_events event
        WHERE event.provider = ? AND event.source_scope_hash = ? AND event.container_hash = ?
          AND NOT EXISTS (
            SELECT 1 FROM source_events newer
            WHERE newer.provider = event.provider
              AND newer.source_scope_hash = event.source_scope_hash
              AND newer.source_record_hash = event.source_record_hash
              AND newer.stream_sequence > event.stream_sequence
          )
          AND (event.occurred_at < ? OR (event.occurred_at = ? AND event.source_record_hash <= ?))
        ORDER BY event.occurred_at DESC, event.source_record_hash DESC, event.event_id DESC LIMIT ?
      `).all(
        target.provider, target.sourceScopeHash, target.containerHash,
        target.occurredAt, target.occurredAt, target.sourceRecordHash, before + 1,
      );
      return rows.reverse().map(sourceEvent);
    } finally { db.close(); }
  }

  summary(): SourceEventSummary {
    const db = this.store.open();
    try {
      const rows = db.query<{
        provider: SourceEventProvider; event_kind: SourceEventKind;
        direction: SourceEventDirection; occurred_at: string;
      }, []>(`${currentEventsSql()}`).all();
      const byProvider = Object.fromEntries(
        sourceEventProviders.map((provider) => [provider, 0]),
      ) as Record<SourceEventProvider, number>;
      const byKind: SourceEventSummary["byKind"] = {};
      const byDirection: SourceEventSummary["byDirection"] = {};
      for (const row of rows) {
        byProvider[row.provider] += 1;
        byKind[row.event_kind] = (byKind[row.event_kind] ?? 0) + 1;
        byDirection[row.direction] = (byDirection[row.direction] ?? 0) + 1;
      }
      return {
        total: rows.length, byProvider, byKind, byDirection,
        earliestOccurredAt: rows.map((row) => row.occurred_at).sort()[0] ?? null,
        latestOccurredAt: rows.map((row) => row.occurred_at).sort().at(-1) ?? null,
      };
    } finally { db.close(); }
  }
}

function normalizeInput(input: AppendSourceEventInput): { occurredAt: string; observedAt: string } {
  for (const [name, value] of Object.entries({
    sourceScopeId: input.sourceScopeId,
    sourceRecordId: input.sourceRecordId,
    containerId: input.containerId,
  })) {
    if (!value || value.length > 1024 || /[\u0000-\u001f]/.test(value)) {
      throw new Error(`invalid source event ${name}`);
    }
  }
  if (!/^sha256:.+/.test(input.sourceVersionHash)) {
    throw new Error("source event version hash is invalid");
  }
  return { occurredAt: iso(input.occurredAt, "occurredAt"), observedAt: iso(input.observedAt, "observedAt") };
}

function opaqueHash(provider: SourceEventProvider, kind: string, value: string): string {
  return sha256Text(`${provider}\u0000${kind}\u0000${value}`);
}

function iso(value: string, name: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`source event ${name} is invalid`);
  return date.toISOString();
}

function currentEventsSql(): string {
  return `SELECT event.* FROM source_events event WHERE NOT EXISTS (
    SELECT 1 FROM source_events newer
    WHERE newer.provider = event.provider
      AND newer.source_scope_hash = event.source_scope_hash
      AND newer.source_record_hash = event.source_record_hash
      AND newer.stream_sequence > event.stream_sequence
  )`;
}

function isCurrent(db: DatabaseConnection, event: SourceEvent): boolean {
  return !db.query<{ present: number }, [string, string, string, number]>(`
    SELECT 1 AS present FROM source_events newer
    WHERE newer.provider = ? AND newer.source_scope_hash = ? AND newer.source_record_hash = ?
      AND newer.stream_sequence > ? LIMIT 1
  `).get(
    event.provider, event.sourceScopeHash, event.sourceRecordHash,
    event.streamSequence,
  );
}

function byId(db: DatabaseConnection, eventId: string): SourceEvent | undefined {
  const row = db.query<SourceEventRow, [string]>(
    "SELECT * FROM source_events WHERE event_id = ?",
  ).get(eventId);
  return row ? sourceEvent(row) : undefined;
}

function sourceEvent(row: SourceEventRow): SourceEvent {
  return {
    eventId: row.event_id, streamSequence: row.stream_sequence,
    provider: row.provider, eventKind: row.event_kind,
    direction: row.direction, sourceScopeHash: row.source_scope_hash,
    sourceRecordHash: row.source_record_hash, containerHash: row.container_hash,
    sourceVersionHash: row.source_version_hash,
    ...(row.previous_event_id ? { previousEventId: row.previous_event_id } : {}),
    occurredAt: row.occurred_at, observedAt: row.observed_at,
    contentAvailable: Boolean(row.content_available), streamVersion: row.stream_version,
  };
}
