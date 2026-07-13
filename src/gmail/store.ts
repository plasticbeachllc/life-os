import type { ModelCallRecord, OperationalStore } from "../db/store";
import type { NormalizedGmailMessage } from "./normalizer";
import { gmailNormalizerVersion } from "./normalizer";
import { sha256Value } from "../util/hashing";
import type {
  ExtractionRecordForProjection, FindingCommunicationContext, FindingRelation, SemanticFinding,
} from "../findings/contract";
import { completeWorkInTransaction, enqueueWorkInTransaction } from "../work/repository";
import { saveFindingSemanticsInTransaction, saveFindingsInTransaction } from "../findings/store";
import { completeReasoningCallInTransaction, type PreparedReasoningUsage } from "../orchestration/prepared-reasoning";
import {
  appendSourceEventInTransaction, requireCurrentSourceEventIdInTransaction,
} from "../events/repository";

export function gmailThreadStateHash(messages: NormalizedGmailMessage[]): string {
  return sha256Value([...messages]
    .sort((left, right) => Number(left.internalDate) - Number(right.internalDate) || left.messageId.localeCompare(right.messageId))
    .map((message) => [message.messageId, message.contentHash]));
}

export class GmailStore {
  constructor(private readonly store: OperationalStore) {}

  upsertAccount(input: {
    accountId: string; emailAddress: string; selectionLabelId: "IMPORTANT_OR_SENT";
    historyId?: string; now: string;
  }): void {
    const db = this.store.open();
    try {
      db.query(
        `INSERT INTO gmail_accounts (
          account_id, email_address, selection_label_id, last_history_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          email_address = excluded.email_address,
          selection_label_id = excluded.selection_label_id,
          last_history_id = COALESCE(excluded.last_history_id, gmail_accounts.last_history_id),
          updated_at = excluded.updated_at`,
      ).run(
        input.accountId, input.emailAddress, input.selectionLabelId,
        input.historyId ?? null, input.now, input.now,
      );
    } finally {
      db.close();
    }
  }

  startRun(input: { runId: string; accountId: string; startedAt: string }): void {
    const db = this.store.open();
    try {
      db.query(
        `INSERT INTO gmail_ingestion_runs (ingestion_run_id, account_id, started_at, status)
         VALUES (?, ?, ?, 'running')`,
      ).run(input.runId, input.accountId, input.startedAt);
    } finally {
      db.close();
    }
  }

  finishRun(input: {
    runId: string; completedAt: string; status: "completed" | "failed";
    discovered: number; ingested: number; unchanged: number; failed: number; error?: string;
  }): void {
    const db = this.store.open();
    try {
      db.query(
        `UPDATE gmail_ingestion_runs SET completed_at = ?, status = ?, discovered_count = ?,
          ingested_count = ?, unchanged_count = ?, failed_count = ?, error = ?
         WHERE ingestion_run_id = ?`,
      ).run(
        input.completedAt, input.status, input.discovered, input.ingested,
        input.unchanged, input.failed, input.error ?? null, input.runId,
      );
    } finally {
      db.close();
    }
  }

  currentMessageHash(accountId: string, messageId: string): string | undefined {
    const db = this.store.open();
    try {
      return db.query<{ content_hash: string }, [string, string]>(
        "SELECT content_hash FROM gmail_messages WHERE account_id = ? AND message_id = ?",
      ).get(accountId, messageId)?.content_hash;
    } finally {
      db.close();
    }
  }

  currentThreadHash(accountId: string, threadId: string): string | undefined {
    const db = this.store.open();
    try {
      return db.query<{ thread_state_hash: string }, [string, string]>(
        "SELECT thread_state_hash FROM gmail_threads WHERE account_id = ? AND thread_id = ?",
      ).get(accountId, threadId)?.thread_state_hash;
    } finally {
      db.close();
    }
  }

  messageIdentity(accountId: string, messageId: string): {
    messageId: string; threadId: string; contentHash: string; internalDate: string;
  } | undefined {
    const db = this.store.open();
    try {
      const row = db.query<{
        message_id: string; thread_id: string; content_hash: string; internal_date: string;
      }, [string, string]>(`
        SELECT message_id, thread_id, content_hash, internal_date FROM gmail_messages
        WHERE account_id = ? AND message_id = ? AND selected_important = 1
      `).get(accountId, messageId);
      return row ? {
        messageId: row.message_id, threadId: row.thread_id,
        contentHash: row.content_hash, internalDate: row.internal_date,
      } : undefined;
    } finally {
      db.close();
    }
  }

  inspectionSummary(accountId: string, identity?: { promptVersion: string; schemaVersion: string }): {
    accountConfigured: boolean; selector: string | null; messages: number; versions: number;
    threads: number; unprocessed: number; unextracted: number; ingestionRuns: number;
    lastRunStatus: string | null; lastRunCompletedAt: string | null;
  } {
    const db = this.store.open();
    try {
      const account = db.query<{ selection_label_id: string }, [string]>(
        "SELECT selection_label_id FROM gmail_accounts WHERE account_id = ?",
      ).get(accountId);
      const counts = db.query<{
        messages: number; unprocessed: number; unextracted: number;
      }, [string]>(`SELECT COUNT(*) AS messages,
          SUM(CASE WHEN last_processed_hash IS NULL THEN 1 ELSE 0 END) AS unprocessed,
          SUM(CASE WHEN last_extraction_hash IS NULL THEN 1 ELSE 0 END) AS unextracted
        FROM gmail_messages WHERE account_id = ?`).get(accountId);
      const versions = db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM gmail_message_versions WHERE account_id = ?",
      ).get(accountId)?.count ?? 0;
      const threads = db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM gmail_threads WHERE account_id = ?",
      ).get(accountId)?.count ?? 0;
      const runs = db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM gmail_ingestion_runs WHERE account_id = ?",
      ).get(accountId)?.count ?? 0;
      const lastRun = db.query<{ status: string; completed_at: string | null }, [string]>(
        "SELECT status, completed_at FROM gmail_ingestion_runs WHERE account_id = ? ORDER BY started_at DESC LIMIT 1",
      ).get(accountId);
      const currentUnextracted = identity
        ? db.query<{ count: number }, [string, string, string]>(
          `SELECT COUNT(*) AS count FROM gmail_messages gm
           WHERE gm.account_id = ? AND NOT EXISTS (
             SELECT 1 FROM gmail_extractions ge
             WHERE ge.account_id = gm.account_id AND ge.message_id = gm.message_id
               AND ge.source_hash = gm.content_hash
               AND ge.prompt_version = ? AND ge.schema_version = ?
           )`,
        ).get(accountId, identity.promptVersion, identity.schemaVersion)?.count ?? 0
        : counts?.unextracted ?? 0;
      return {
        accountConfigured: Boolean(account), selector: account?.selection_label_id ?? null,
        messages: counts?.messages ?? 0, versions, threads,
        unprocessed: counts?.unprocessed ?? 0, unextracted: currentUnextracted,
        ingestionRuns: runs, lastRunStatus: lastRun?.status ?? null,
        lastRunCompletedAt: lastRun?.completed_at ?? null,
      };
    } finally {
      db.close();
    }
  }

  extractionReview(accountId: string, identity?: { promptVersion: string; schemaVersion: string }): {
    total: number; byClassification: Record<string, number>; actionable: number;
    unresolved: number; extractions: Array<{
      extractionId: string; classification: string; summary: string;
      items: unknown[]; unresolved: string[]; promptInjectionDetected: boolean; createdAt: string;
    }>;
  } {
    const db = this.store.open();
    try {
      const rows = db.query<{
        extraction_id: string; classification: string; output_json: string; created_at: string;
        prompt_version: string; schema_version: string;
      }, [string]>(
        `SELECT ge.extraction_id, ge.classification, ge.output_json, ge.created_at,
                ge.prompt_version, ge.schema_version
         FROM gmail_extractions ge
         WHERE ge.account_id = ? AND NOT EXISTS (
           SELECT 1 FROM gmail_extractions newer
           WHERE newer.account_id = ge.account_id AND newer.message_id = ge.message_id
             AND (newer.created_at > ge.created_at
               OR (newer.created_at = ge.created_at AND newer.extraction_id > ge.extraction_id))
         )
         ORDER BY ge.created_at DESC`,
      ).all(accountId).filter((row) => !identity
        || (row.prompt_version === identity.promptVersion && row.schema_version === identity.schemaVersion));
      const byClassification: Record<string, number> = {};
      let unresolved = 0;
      const extractions = rows.map((row) => {
        const output = JSON.parse(row.output_json) as Record<string, unknown>;
        const unresolvedItems = Array.isArray(output.unresolved) ? output.unresolved.map(String) : [];
        byClassification[row.classification] = (byClassification[row.classification] ?? 0) + 1;
        unresolved += unresolvedItems.length;
        return {
          extractionId: row.extraction_id, classification: row.classification,
          summary: String(output.summary ?? ""),
          items: Array.isArray(output.items) ? output.items.map(sanitizeReviewItem) : [],
          unresolved: unresolvedItems,
          promptInjectionDetected: output.promptInjectionDetected === true,
          createdAt: row.created_at,
        };
      });
      return {
        total: extractions.length, byClassification,
        actionable: byClassification.actionable ?? 0, unresolved, extractions,
      };
    } finally {
      db.close();
    }
  }

  getExtraction(extractionId: string): { sourceHash: string; output: Record<string, unknown> } | undefined {
    const db = this.store.open();
    try {
      const row = db.query<{ source_hash: string; output_json: string }, [string]>(
        "SELECT source_hash, output_json FROM gmail_extractions WHERE extraction_id=?",
      ).get(extractionId);
      return row ? { sourceHash: row.source_hash, output: JSON.parse(row.output_json) } : undefined;
    } finally { db.close(); }
  }

  listExtractionsForFindingProjection(): ExtractionRecordForProjection[] {
    const db = this.store.open();
    try {
      return db.query<{
        extraction_id: string; call_id: string; output_json: string; created_at: string;
      }, []>(`
        SELECT extraction_id, call_id, output_json, created_at
        FROM gmail_extractions ORDER BY created_at, extraction_id
      `).all().map((row) => ({
        sourceType: "gmail_extraction",
        extractionId: row.extraction_id,
        callId: row.call_id,
        output: JSON.parse(row.output_json) as Record<string, unknown>,
        createdAt: row.created_at,
      }));
    } finally {
      db.close();
    }
  }

  invalidateExtractionVersion(input: {
    accountId: string; promptVersion: string; schemaVersion: string; policyVersion: string;
  }): number {
    const db = this.store.open();
    try {
      return db.transaction(() => {
        const changed = db.query(
          `UPDATE gmail_messages SET last_extraction_hash = NULL, ingestion_state = 'ingested'
         WHERE account_id = ? AND last_extraction_hash IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM gmail_extractions ge
           WHERE ge.account_id = gmail_messages.account_id
             AND ge.message_id = gmail_messages.message_id
             AND ge.source_hash = gmail_messages.content_hash
             AND ge.prompt_version = ? AND ge.schema_version = ? AND ge.policy_version = ?
         )`,
        ).run(input.accountId, input.promptVersion, input.schemaVersion, input.policyVersion).changes;
        if (changed > 0) {
          const rows = db.query<{
            message_id: string; thread_id: string; content_hash: string; thread_state_hash: string;
          }, [string]>(`
            SELECT message.message_id, message.thread_id, message.content_hash, thread.thread_state_hash
            FROM gmail_messages message JOIN gmail_threads thread
              ON thread.account_id = message.account_id AND thread.thread_id = message.thread_id
            WHERE message.account_id = ? AND message.last_extraction_hash IS NULL
              AND EXISTS (SELECT 1 FROM gmail_extractions prior
                WHERE prior.account_id = message.account_id AND prior.message_id = message.message_id)
          `).all(input.accountId);
          const now = new Date().toISOString();
          for (const row of rows) enqueueWorkInTransaction(db, {
            workflow: "gmail_extraction", subjectType: "gmail_message",
            subjectSourceId: input.accountId, subjectId: row.message_id, anchorId: row.message_id,
            sourceHash: row.content_hash, containerHash: row.thread_state_hash,
            reason: "contract_refresh", now,
            streamEventId: requireCurrentSourceEventIdInTransaction(db, {
              provider: "gmail", sourceScopeId: input.accountId, sourceRecordId: row.message_id,
            }),
            contractIdentity: `${input.promptVersion}:${input.schemaVersion}:${input.policyVersion}`,
          });
        }
        return changed;
      })();
    } finally {
      db.close();
    }
  }

  findExtraction(input: {
    accountId: string; messageId: string; sourceHash: string;
    promptVersion: string; schemaVersion: string; policyVersion: string;
  }): { extractionId: string; output: Record<string, unknown> } | undefined {
    const db = this.store.open();
    try {
      const row = db.query<{ extraction_id: string; output_json: string }, [string, string, string, string, string, string]>(
        `SELECT extraction_id, output_json FROM gmail_extractions
         WHERE account_id = ? AND message_id = ? AND source_hash = ?
           AND prompt_version = ? AND schema_version = ? AND policy_version = ?`,
      ).get(
        input.accountId, input.messageId, input.sourceHash,
        input.promptVersion, input.schemaVersion, input.policyVersion,
      );
      return row ? { extractionId: row.extraction_id, output: JSON.parse(row.output_json) as Record<string, unknown> } : undefined;
    } finally {
      db.close();
    }
  }

  saveExtraction(input: {
    extractionId: string; accountId: string; messageId: string; sourceHash: string;
    threadStateHash: string; callId: string; classification: string;
    output: Record<string, unknown>; promptVersion: string; schemaVersion: string;
    policyVersion: string; model: string; createdAt: string;
    call?: ModelCallRecord; usage?: PreparedReasoningUsage; findings?: SemanticFinding[];
    communicationContexts?: FindingCommunicationContext[]; relations?: FindingRelation[];
    workId?: string; leaseOwner?: string;
  }): void {
    const db = this.store.open();
    try {
      db.transaction(() => {
        db.query(
          `INSERT INTO gmail_extractions (
            extraction_id, account_id, message_id, source_hash, thread_state_hash,
            call_id, classification, output_json, prompt_version, schema_version,
            policy_version, model, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.extractionId, input.accountId, input.messageId, input.sourceHash,
          input.threadStateHash, input.callId, input.classification,
          JSON.stringify(input.output), input.promptVersion, input.schemaVersion,
          input.policyVersion, input.model, input.createdAt,
        );
        db.query(
          `UPDATE gmail_messages SET last_extraction_hash = ?, last_processed_hash = ?,
             ingestion_state = 'extracted'
           WHERE account_id = ? AND message_id = ? AND content_hash = ?`,
        ).run(input.sourceHash, input.sourceHash, input.accountId, input.messageId, input.sourceHash);
        db.query(
          `UPDATE model_calls SET status = 'superseded', completed_at = ?
           WHERE workflow = 'gmail_extraction' AND task_type = 'subscription_email_extraction'
             AND source_hash = ? AND status = 'prepared' AND call_id <> ?`,
        ).run(input.createdAt, input.sourceHash, input.callId);
        if (input.call && input.findings && input.communicationContexts && input.relations
          && input.workId && input.leaseOwner) {
          saveFindingsInTransaction(db, input.findings);
          saveFindingSemanticsInTransaction(db, {
            communicationContexts: input.communicationContexts, relations: input.relations,
          });
          completeReasoningCallInTransaction(db, {
            call: input.call, ...(input.usage ? { usage: input.usage } : {}), completedAt: input.createdAt,
          });
          completeWorkInTransaction(db, {
            workId: input.workId, leaseOwner: input.leaseOwner,
            sourceHash: input.sourceHash, containerHash: input.threadStateHash,
            completedAt: input.createdAt,
          });
        } else if (input.call || input.findings || input.communicationContexts || input.relations
          || input.workId || input.leaseOwner) {
          throw new Error("transactional Gmail extraction completion is incomplete");
        }
      })();
    } finally {
      db.close();
    }
  }

  reconcileCompletedExtractions(accountId: string, now: string): { messages: number; calls: number } {
    const db = this.store.open();
    try {
      return db.transaction(() => {
        const messages = db.query(
          `UPDATE gmail_messages SET last_processed_hash = content_hash
           WHERE account_id = ? AND last_extraction_hash = content_hash
             AND last_processed_hash IS NOT content_hash`,
        ).run(accountId).changes;
        const calls = db.query(
          `UPDATE model_calls SET status = 'superseded', completed_at = ?
           WHERE workflow = 'gmail_extraction' AND task_type = 'subscription_email_extraction'
             AND status = 'prepared' AND EXISTS (
               SELECT 1 FROM gmail_extractions ge WHERE ge.source_hash = model_calls.source_hash
             )`,
        ).run(now).changes;
        return { messages, calls };
      })();
    } finally {
      db.close();
    }
  }

  saveMessageAndThread(input: {
    accountId: string; message: NormalizedGmailMessage;
    threadMessages: NormalizedGmailMessage[]; now: string;
  }): void {
    const ordered = [...input.threadMessages].sort((left, right) =>
      Number(left.internalDate) - Number(right.internalDate) || left.messageId.localeCompare(right.messageId),
    );
    const latest = ordered.at(-1) ?? input.message;
    const threadStateHash = gmailThreadStateHash(ordered);
    const db = this.store.open();
    try {
      db.transaction(() => {
        db.query(
          `INSERT INTO gmail_threads (
            account_id, thread_id, thread_state_hash, ordered_message_ids_json,
            latest_message_id, latest_internal_date, message_count, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, thread_id) DO UPDATE SET
            thread_state_hash = excluded.thread_state_hash,
            ordered_message_ids_json = excluded.ordered_message_ids_json,
            latest_message_id = excluded.latest_message_id,
            latest_internal_date = excluded.latest_internal_date,
            message_count = excluded.message_count,
            updated_at = excluded.updated_at`,
        ).run(
          input.accountId, input.message.threadId, threadStateHash,
          JSON.stringify(ordered.map((message) => message.messageId)),
          latest.messageId, latest.internalDate, ordered.length, input.now,
        );
        db.query(
          `INSERT INTO gmail_messages (
            account_id, message_id, thread_id, internal_date, from_address,
            to_addresses_json, cc_addresses_json, subject, rfc_message_id,
            selected_important, content_hash, current_version_hash, ingestion_state,
            first_ingested_at, last_ingested_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'ingested', ?, ?)
          ON CONFLICT(account_id, message_id) DO UPDATE SET
            thread_id = excluded.thread_id,
            internal_date = excluded.internal_date,
            from_address = excluded.from_address,
            to_addresses_json = excluded.to_addresses_json,
            cc_addresses_json = excluded.cc_addresses_json,
            subject = excluded.subject,
            rfc_message_id = excluded.rfc_message_id,
            selected_important = 1,
            content_hash = excluded.content_hash,
            current_version_hash = excluded.current_version_hash,
            ingestion_state = 'ingested',
            last_ingested_at = excluded.last_ingested_at`,
        ).run(
          input.accountId, input.message.messageId, input.message.threadId,
          input.message.internalDate, input.message.fromAddress,
          JSON.stringify(input.message.toAddresses), JSON.stringify(input.message.ccAddresses),
          input.message.subject, input.message.rfcMessageId,
          input.message.contentHash, input.message.contentHash, input.now, input.now,
        );
        db.query(
          `INSERT OR IGNORE INTO gmail_message_versions (
            account_id, message_id, content_hash, thread_id, headers_hash,
            normalized_body_hash, authored_body_hash, quoted_body_hash,
            normalizer_version, body_character_count, authored_character_count,
            quoted_character_count, discovered_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.accountId, input.message.messageId, input.message.contentHash,
          input.message.threadId, input.message.headersHash,
          input.message.normalizedBodyHash, input.message.authoredBodyHash,
          input.message.quotedBodyHash, gmailNormalizerVersion,
          input.message.normalizedBody.length, input.message.authoredBody.length,
          input.message.quotedBody.length, input.now,
        );
        const streamEvent = appendSourceEventInTransaction(db, {
          provider: "gmail", eventKind: "message", direction: gmailDirection(input.message),
          sourceScopeId: input.accountId, sourceRecordId: input.message.messageId,
          containerId: input.message.threadId, sourceVersionHash: input.message.contentHash,
          occurredAt: new Date(Number(input.message.internalDate)).toISOString(),
          observedAt: input.now, contentAvailable: input.message.authoredBody.length > 0,
        });
        const pending = db.query<{
          message_id: string; content_hash: string;
        }, [string, string]>(`
          SELECT message_id, content_hash FROM gmail_messages
          WHERE account_id = ? AND thread_id = ?
            AND (last_extraction_hash IS NULL OR last_extraction_hash <> content_hash)
          ORDER BY CAST(internal_date AS INTEGER), message_id
        `).all(input.accountId, input.message.threadId);
        for (const candidate of pending) enqueueWorkInTransaction(db, {
          workflow: "gmail_extraction", subjectType: "gmail_message",
          subjectSourceId: input.accountId, subjectId: candidate.message_id,
          anchorId: candidate.message_id, sourceHash: candidate.content_hash,
          containerHash: threadStateHash, reason: "source_delta", now: input.now,
          streamEventId: candidate.message_id === input.message.messageId
            ? streamEvent.event.eventId
            : requireCurrentSourceEventIdInTransaction(db, {
              provider: "gmail", sourceScopeId: input.accountId,
              sourceRecordId: candidate.message_id,
            }),
        });
      })();
    } finally {
      db.close();
    }
  }
}

function gmailDirection(message: NormalizedGmailMessage): "incoming" | "outgoing" | "draft" {
  if (message.labelIds.includes("DRAFT")) return "draft";
  return message.labelIds.includes("SENT") ? "outgoing" : "incoming";
}

function sanitizeReviewItem(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries([
    ...Object.entries(record).filter(([key]) => key !== "evidenceIds"),
    ["evidenceCount", Array.isArray(record.evidenceIds) ? record.evidenceIds.length : 0],
  ]);
}
