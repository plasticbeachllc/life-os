import type { OperationalStore } from "../db/store";
import type { CanonicalSubjectRef, SourceSubjectLink } from "../events/contract";
import { currentSourceEventInTransaction } from "../events/repository";
import { appendSourceSubjectLinkInTransaction } from "../events/subject-links";

export function linkCalendarEventToProject(input: {
  store: OperationalStore; accountId: string; sourceEventId: string; projectId: string;
}): LinkCalendarSubjectResult {
  return linkCalendarEventToSubject({ ...input, subject: { type: "project", id: input.projectId } });
}

export function linkCalendarEventToTask(input: {
  store: OperationalStore; accountId: string; sourceEventId: string; taskId: string;
}): LinkCalendarSubjectResult {
  return linkCalendarEventToSubject({ ...input, subject: { type: "task", id: input.taskId } });
}

interface LinkCalendarSubjectResult {
  linked: true;
  linkId: string;
  subject: CanonicalSubjectRef;
}

function linkCalendarEventToSubject(input: {
  store: OperationalStore; accountId: string; sourceEventId: string;
  subject: CanonicalSubjectRef;
}): LinkCalendarSubjectResult {
  input.store.migrate();
  requireProviderId(input.sourceEventId, "Calendar event");
  const db = input.store.open();
  try {
    const link = db.transaction(() => {
      const eventRecord = db.query<{
        calendar_id: string; content_hash: string;
      }, [string, string, string]>(`
        SELECT calendar_id, content_hash FROM calendar_events
        WHERE account_id = ? AND event_id = ?
          AND calendar_id = (SELECT calendar_id FROM calendar_accounts WHERE account_id = ?)
        ORDER BY last_ingested_at DESC LIMIT 1
      `).get(input.accountId, input.sourceEventId, input.accountId);
      if (!eventRecord) throw new Error("ingested primary Calendar event not found");
      const sourceRecordId = `${eventRecord.calendar_id}:${input.sourceEventId}`;
      const event = currentSourceEventInTransaction(db, {
        provider: "calendar", sourceScopeId: input.accountId, sourceRecordId,
      });
      if (!event || event.sourceVersionHash !== eventRecord.content_hash) {
        throw new Error("current Calendar source event not found; ingest again before linking");
      }
      return appendSourceSubjectLinkInTransaction(db, {
        eventId: event.eventId, subject: input.subject, basis: "reviewed",
      });
    })();
    return result(link);
  } finally { db.close(); }
}

function result(link: SourceSubjectLink): LinkCalendarSubjectResult {
  return { linked: true, linkId: link.linkId, subject: link.subject };
}

function requireProviderId(value: string, label: string): void {
  if (!value || value.length > 1024 || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`invalid ${label} ID`);
  }
}
