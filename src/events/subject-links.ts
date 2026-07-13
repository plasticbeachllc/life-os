import type { OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";
import type {
  CanonicalSubjectRef, CanonicalSubjectType, SourceEvent, SourceEventProvider, SourceSubjectLink,
} from "./contract";

type DatabaseConnection = ReturnType<OperationalStore["open"]>;
type SubjectLinkBasis = "explicit_config" | "reviewed";

interface SourceSubjectLinkRow {
  link_id: string;
  provider: SourceEventProvider;
  source_scope_hash: string;
  container_hash: string;
  relationship: "concerns";
  subject_type: CanonicalSubjectType;
  subject_id: string;
  basis: SubjectLinkBasis;
  confidence: number;
  validated_event_id: string;
  validation_hash: string;
  created_at: string;
}

interface SourceEventRow {
  event_id: string;
  stream_sequence: number;
  provider: SourceEventProvider;
  event_kind: SourceEvent["eventKind"];
  direction: SourceEvent["direction"];
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

export const SOURCE_SUBJECT_LINK_VERSION = "source-subject-link-v1";

export function appendSourceSubjectLinkInTransaction(db: DatabaseConnection, input: {
  eventId: string;
  subject: CanonicalSubjectRef;
  basis: SubjectLinkBasis;
  validationSourceHash?: string;
  legacySubjectLinkId?: string;
  createdAt?: string;
}): SourceSubjectLink {
  requireCanonicalSubject(input.subject);
  const event = currentEvent(db, input.eventId);
  if (!event) throw new Error("current source event not found for subject link");
  const stateType = `${input.subject.type}_state`;
  const state = db.query<{
    state_id: string; state_version: number; dependency_hash: string;
  }, [string, string]>(`
    SELECT state_id, state_version, dependency_hash FROM derived_states
    WHERE state_type = ? AND entity_id = ? AND superseded_at IS NULL
    ORDER BY state_version DESC LIMIT 1
  `).get(stateType, input.subject.id);
  if (!state) throw new Error("current canonical subject state not found");
  const validationHash = sha256Value({
    version: SOURCE_SUBJECT_LINK_VERSION,
    validatedEventId: event.event_id,
    sourceVersionHash: event.source_version_hash,
    sourceValidationHash: input.validationSourceHash ?? event.source_version_hash,
    subject: input.subject,
    subjectStateId: state.state_id,
    subjectStateVersion: state.state_version,
    subjectDependencyHash: state.dependency_hash,
  });
  const identity = {
    provider: event.provider,
    sourceScopeHash: event.source_scope_hash,
    containerHash: event.container_hash,
    relationship: "concerns",
    subject: input.subject,
    validationHash,
  } as const;
  const linkId = `sourcelink_${sha256Value(identity).slice("sha256:".length, "sha256:".length + 24)}`;
  db.query(`
    INSERT OR IGNORE INTO source_subject_links (
      link_id, provider, source_scope_hash, container_hash, relationship,
      subject_type, subject_id, basis, confidence, validated_event_id,
      validation_hash, legacy_subject_link_id, created_at, revoked_at
    ) VALUES (?, ?, ?, ?, 'concerns', ?, ?, ?, 1, ?, ?, ?, ?, NULL)
  `).run(
    linkId, event.provider, event.source_scope_hash, event.container_hash,
    input.subject.type, input.subject.id, input.basis, event.event_id,
    validationHash, input.legacySubjectLinkId ?? null,
    iso(input.createdAt ?? new Date().toISOString()),
  );
  return sourceSubjectLink(db.query<SourceSubjectLinkRow, [string]>(
    "SELECT * FROM source_subject_links WHERE link_id = ?",
  ).get(linkId)!);
}

export class SourceSubjectLinkRepository {
  constructor(private readonly store: OperationalStore) {}

  link(input: {
    eventId: string;
    subject: CanonicalSubjectRef;
    basis: SubjectLinkBasis;
    createdAt?: string;
  }): SourceSubjectLink {
    const db = this.store.open();
    try {
      return db.transaction(() => appendSourceSubjectLinkInTransaction(db, input))();
    } finally { db.close(); }
  }

  revoke(input: { linkId: string; revokedAt?: string }): boolean {
    if (!/^sourcelink_[a-f0-9]{24}$/.test(input.linkId)) {
      throw new Error("invalid source subject link ID");
    }
    const db = this.store.open();
    try {
      return db.query(`
        UPDATE source_subject_links SET revoked_at = ?
        WHERE link_id = ? AND revoked_at IS NULL
      `).run(iso(input.revokedAt ?? new Date().toISOString()), input.linkId).changes === 1;
    } finally { db.close(); }
  }

  linkedSubjects(eventId: string): CanonicalSubjectRef[] {
    const db = this.store.open();
    try {
      const event = currentEvent(db, eventId);
      if (!event) throw new Error("current source event not found");
      return db.query<{
        subject_type: CanonicalSubjectType; subject_id: string;
      }, [SourceEventProvider, string, string]>(`
        SELECT DISTINCT link.subject_type, link.subject_id
        FROM source_subject_links link
        WHERE link.provider = ? AND link.source_scope_hash = ? AND link.container_hash = ?
          AND ${validLinkSql("link")}
        ORDER BY link.subject_type, link.subject_id
      `).all(event.provider, event.source_scope_hash, event.container_hash).map((row) => ({
        type: row.subject_type, id: row.subject_id,
      }));
    } finally { db.close(); }
  }

  causalWindow(input: { eventId: string; before?: number }): SourceEvent[] {
    const before = input.before ?? 20;
    if (!Number.isInteger(before) || before < 0 || before > 100) {
      throw new Error("subject causal window must be between 0 and 100");
    }
    const db = this.store.open();
    try {
      const target = currentEvent(db, input.eventId);
      if (!target) throw new Error("current source event not found");
      const subjects = db.query<{ present: number }, [SourceEventProvider, string, string]>(`
        SELECT 1 AS present FROM source_subject_links link
        WHERE link.provider = ? AND link.source_scope_hash = ? AND link.container_hash = ?
          AND ${validLinkSql("link")} LIMIT 1
      `).get(target.provider, target.source_scope_hash, target.container_hash);
      if (!subjects) throw new Error("source event has no current canonical subject link");
      const rows = db.query<SourceEventRow, [
        SourceEventProvider, string, string, string, string, SourceEventProvider,
        SourceEventProvider, string, string, string, number,
      ]>(`
        SELECT DISTINCT event.* FROM source_events event
        JOIN source_subject_links candidate
          ON candidate.provider = event.provider
         AND candidate.source_scope_hash = event.source_scope_hash
         AND candidate.container_hash = event.container_hash
        WHERE ${validLinkSql("candidate")}
          AND EXISTS (
            SELECT 1 FROM source_subject_links target_link
            WHERE target_link.provider = ? AND target_link.source_scope_hash = ?
              AND target_link.container_hash = ? AND ${validLinkSql("target_link")}
              AND target_link.relationship = candidate.relationship
              AND target_link.subject_type = candidate.subject_type
              AND target_link.subject_id = candidate.subject_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM source_events newer
            WHERE newer.provider = event.provider
              AND newer.source_scope_hash = event.source_scope_hash
              AND newer.source_record_hash = event.source_record_hash
              AND newer.stream_sequence > event.stream_sequence
          )
          AND (event.occurred_at < ? OR (event.occurred_at = ? AND (
            event.provider < ? OR (event.provider = ? AND (
              event.source_record_hash < ? OR (event.source_record_hash = ? AND event.event_id <= ?)
            ))
          )))
        ORDER BY event.occurred_at DESC, event.provider DESC,
          event.source_record_hash DESC, event.event_id DESC LIMIT ?
      `).all(
        target.provider, target.source_scope_hash, target.container_hash,
        target.occurred_at, target.occurred_at, target.provider, target.provider,
        target.source_record_hash, target.source_record_hash, target.event_id, before + 1,
      );
      return rows.reverse().map(sourceEvent);
    } finally { db.close(); }
  }
}

function validLinkSql(alias: string): string {
  return `${alias}.revoked_at IS NULL
    AND EXISTS (
      SELECT 1 FROM derived_states subject_state
      WHERE subject_state.state_type = ${alias}.subject_type || '_state'
        AND subject_state.entity_id = ${alias}.subject_id
        AND subject_state.superseded_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM source_events validated_event
      WHERE validated_event.event_id = ${alias}.validated_event_id
        AND NOT EXISTS (
          SELECT 1 FROM source_events revised_event
          WHERE revised_event.provider = validated_event.provider
            AND revised_event.source_scope_hash = validated_event.source_scope_hash
            AND revised_event.source_record_hash = validated_event.source_record_hash
            AND revised_event.stream_sequence > validated_event.stream_sequence
        )
    )
    AND (
    ${alias}.legacy_subject_link_id IS NULL OR EXISTS (
      SELECT 1 FROM subject_links legacy
      JOIN imessage_conversations conversation
        ON conversation.source_id = legacy.from_source_id
       AND conversation.conversation_id = legacy.from_id
       AND conversation.participant_set_hash = legacy.source_hash
      WHERE legacy.link_id = ${alias}.legacy_subject_link_id
    )
    )`;
}

function currentEvent(db: DatabaseConnection, eventId: string): SourceEventRow | undefined {
  return db.query<SourceEventRow, [string]>(`
    SELECT event.* FROM source_events event WHERE event.event_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM source_events newer
        WHERE newer.provider = event.provider
          AND newer.source_scope_hash = event.source_scope_hash
          AND newer.source_record_hash = event.source_record_hash
          AND newer.stream_sequence > event.stream_sequence
      )
  `).get(eventId) ?? undefined;
}

function sourceEvent(row: SourceEventRow): SourceEvent {
  return {
    eventId: row.event_id, streamSequence: row.stream_sequence,
    provider: row.provider, eventKind: row.event_kind, direction: row.direction,
    sourceScopeHash: row.source_scope_hash, sourceRecordHash: row.source_record_hash,
    containerHash: row.container_hash, sourceVersionHash: row.source_version_hash,
    ...(row.previous_event_id ? { previousEventId: row.previous_event_id } : {}),
    occurredAt: row.occurred_at, observedAt: row.observed_at,
    contentAvailable: Boolean(row.content_available), streamVersion: row.stream_version,
  };
}

function sourceSubjectLink(row: SourceSubjectLinkRow): SourceSubjectLink {
  return {
    linkId: row.link_id, provider: row.provider,
    sourceScopeHash: row.source_scope_hash, containerHash: row.container_hash,
    relationship: row.relationship, subject: { type: row.subject_type, id: row.subject_id },
    basis: row.basis, confidence: row.confidence,
    validatedEventId: row.validated_event_id, validationHash: row.validation_hash,
    createdAt: row.created_at,
  };
}

function requireCanonicalSubject(subject: CanonicalSubjectRef): void {
  const prefix = `${subject.type}_`;
  if (!subject.id.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(subject.id)) {
    throw new Error("invalid canonical subject ID");
  }
}

function iso(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("source subject link timestamp is invalid");
  return parsed.toISOString();
}
