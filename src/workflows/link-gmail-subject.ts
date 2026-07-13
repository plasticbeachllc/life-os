import type { OperationalStore } from "../db/store";
import type { CanonicalSubjectRef, SourceSubjectLink } from "../events/contract";
import { currentSourceEventInTransaction } from "../events/repository";
import { appendSourceSubjectLinkInTransaction } from "../events/subject-links";

export function linkGmailThreadToPerson(input: {
  store: OperationalStore; accountId: string; sourceMessageId: string; personId: string;
}): LinkGmailSubjectResult {
  return linkGmailThreadToSubject({ ...input, subject: { type: "person", id: input.personId } });
}

export function linkGmailThreadToProject(input: {
  store: OperationalStore; accountId: string; sourceMessageId: string; projectId: string;
}): LinkGmailSubjectResult {
  return linkGmailThreadToSubject({ ...input, subject: { type: "project", id: input.projectId } });
}

interface LinkGmailSubjectResult {
  linked: true;
  linkId: string;
  subject: CanonicalSubjectRef;
}

function linkGmailThreadToSubject(input: {
  store: OperationalStore; accountId: string; sourceMessageId: string;
  subject: CanonicalSubjectRef;
}): LinkGmailSubjectResult {
  input.store.migrate();
  requireProviderId(input.sourceMessageId, "Gmail message");
  const db = input.store.open();
  try {
    const link = db.transaction(() => {
      const message = db.query<{ thread_id: string; content_hash: string }, [string, string]>(`
        SELECT thread_id, content_hash FROM gmail_messages
        WHERE account_id = ? AND message_id = ?
      `).get(input.accountId, input.sourceMessageId);
      if (!message) throw new Error("ingested selected Gmail message not found");
      const event = currentSourceEventInTransaction(db, {
        provider: "gmail", sourceScopeId: input.accountId,
        sourceRecordId: input.sourceMessageId,
      });
      if (!event || event.sourceVersionHash !== message.content_hash) {
        throw new Error("current Gmail source event not found; ingest again before linking");
      }
      return appendSourceSubjectLinkInTransaction(db, {
        eventId: event.eventId, subject: input.subject, basis: "reviewed",
      });
    })();
    return result(link);
  } finally { db.close(); }
}

function result(link: SourceSubjectLink): LinkGmailSubjectResult {
  return { linked: true, linkId: link.linkId, subject: link.subject };
}

function requireProviderId(value: string, label: string): void {
  if (!value || value.length > 512 || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`invalid ${label} ID`);
  }
}
