import type { ModelCallRecord, OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";
import type { NormalizedIMessage } from "./normalizer";
import { imessageNormalizerVersion } from "./normalizer";
import type { ExtractionRecordForProjection, SemanticFinding } from "../findings/contract";
import { completeWorkInTransaction, enqueueWorkInTransaction } from "../work/repository";
import { saveFindingsInTransaction } from "../findings/store";
import { completeReasoningCallInTransaction, type PreparedReasoningUsage } from "../orchestration/prepared-reasoning";

export class IMessageStore {
  constructor(private readonly store: OperationalStore) {}

  ensureSource(input: { sourceId: string; now: string }): void {
    const db = this.store.open();
    try {
      db.query(`
        INSERT INTO imessage_sources (
          source_id, last_row_id, normalizer_version, created_at, updated_at
        ) VALUES (?, 0, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          normalizer_version = excluded.normalizer_version,
          updated_at = excluded.updated_at
      `).run(input.sourceId, imessageNormalizerVersion, input.now, input.now);
    } finally {
      db.close();
    }
  }

  cursor(sourceId: string): number {
    const db = this.store.open();
    try {
      return db.query<{ last_row_id: number }, [string]>(
        "SELECT last_row_id FROM imessage_sources WHERE source_id = ?",
      ).get(sourceId)?.last_row_id ?? 0;
    } finally {
      db.close();
    }
  }

  sourceIdentity(sourceId: string, messageId: string): {
    messageId: string; conversationId: string; sourceRowId: number;
    contentHash: string; participantSetHash: string;
  } | undefined {
    const db = this.store.open();
    try {
      const row = db.query<{
        message_id: string; conversation_id: string; source_row_id: number;
        content_hash: string; participant_set_hash: string;
      }, [string, string]>(`
        SELECT message_id, conversation_id, source_row_id, content_hash, participant_set_hash
        FROM imessage_messages WHERE source_id = ? AND message_id = ?
      `).get(sourceId, messageId);
      return row ? {
        messageId: row.message_id, conversationId: row.conversation_id,
        sourceRowId: row.source_row_id, contentHash: row.content_hash,
        participantSetHash: row.participant_set_hash,
      } : undefined;
    } finally {
      db.close();
    }
  }

  conversationStateHash(sourceId: string, conversationId: string): string | undefined {
    const db = this.store.open();
    try {
      return db.query<{ conversation_state_hash: string }, [string, string]>(`
        SELECT conversation_state_hash FROM imessage_conversations
        WHERE source_id = ? AND conversation_id = ?
      `).get(sourceId, conversationId)?.conversation_state_hash;
    } finally {
      db.close();
    }
  }

  previousProcessedSentAt(sourceId: string, conversationId: string): string | null {
    const db = this.store.open();
    try {
      return db.query<{ sent_at: string | null }, [string, string, string, string]>(`
        SELECT MAX(processed.sent_at) AS sent_at FROM (
          SELECT message.sent_at FROM imessage_extractions extraction
          JOIN imessage_messages message ON message.source_id = extraction.source_id
            AND message.message_id = extraction.message_id
          WHERE extraction.source_id = ? AND extraction.conversation_id = ?
          UNION ALL
          SELECT message.sent_at FROM imessage_deterministic_triage triage
          JOIN imessage_messages message ON message.source_id = triage.source_id
            AND message.message_id = triage.message_id
          WHERE triage.source_id = ? AND triage.conversation_id = ?
        ) processed
      `).get(sourceId, conversationId, sourceId, conversationId)?.sent_at ?? null;
    } finally {
      db.close();
    }
  }

  findExtraction(input: {
    sourceId: string; messageId: string; sourceHash: string;
    promptVersion: string; schemaVersion: string; policyVersion: string;
  }): { extractionId: string; output: Record<string, unknown> } | undefined {
    const db = this.store.open();
    try {
      const row = db.query<{ extraction_id: string; output_json: string }, [string, string, string, string, string, string]>(`
        SELECT extraction_id, output_json FROM imessage_extractions
        WHERE source_id = ? AND message_id = ? AND source_hash = ?
          AND prompt_version = ? AND schema_version = ? AND policy_version = ?
      `).get(
        input.sourceId, input.messageId, input.sourceHash, input.promptVersion,
        input.schemaVersion, input.policyVersion,
      );
      return row ? {
        extractionId: row.extraction_id,
        output: JSON.parse(row.output_json) as Record<string, unknown>,
      } : undefined;
    } finally {
      db.close();
    }
  }

  enqueueExtractionRefreshes(input: {
    sourceId: string; promptVersion: string; schemaVersion: string; policyVersion: string; now: string;
  }): number {
    const db = this.store.open();
    try {
      return db.transaction(() => {
        const rows = db.query<{
          conversation_id: string; conversation_state_hash: string;
          message_id: string; content_hash: string;
        }, [string, string, string, string]>(`
          SELECT conversation.conversation_id, conversation.conversation_state_hash,
            anchor.message_id, anchor.content_hash
          FROM imessage_conversations conversation
          JOIN imessage_messages anchor ON anchor.source_id = conversation.source_id
            AND anchor.conversation_id = conversation.conversation_id
            AND anchor.message_id = (
              SELECT candidate.message_id FROM imessage_messages candidate
              WHERE candidate.source_id = conversation.source_id
                AND candidate.conversation_id = conversation.conversation_id
                AND candidate.text_available = 1 AND candidate.text_character_count > 0
              ORDER BY candidate.sent_at DESC, candidate.source_row_id DESC LIMIT 1
            )
          WHERE conversation.source_id = ?
            AND EXISTS (SELECT 1 FROM imessage_extractions prior
              WHERE prior.source_id = conversation.source_id
                AND prior.conversation_id = conversation.conversation_id
                AND prior.conversation_state_hash = conversation.conversation_state_hash)
            AND NOT EXISTS (SELECT 1 FROM imessage_extractions current
              WHERE current.source_id = conversation.source_id
                AND current.conversation_id = conversation.conversation_id
                AND current.conversation_state_hash = conversation.conversation_state_hash
                AND current.prompt_version = ? AND current.schema_version = ?
                AND current.policy_version = ?)
        `).all(input.sourceId, input.promptVersion, input.schemaVersion, input.policyVersion);
        for (const row of rows) enqueueWorkInTransaction(db, {
          workflow: "imessage_extraction", subjectType: "imessage_conversation",
          subjectSourceId: input.sourceId, subjectId: row.conversation_id,
          anchorId: row.message_id, sourceHash: row.content_hash,
          containerHash: row.conversation_state_hash, reason: "contract_refresh", now: input.now,
          contractIdentity: `${input.promptVersion}:${input.schemaVersion}:${input.policyVersion}`,
        });
        return rows.length;
      })();
    } finally {
      db.close();
    }
  }

  saveExtraction(input: {
    extractionId: string; sourceId: string; messageId: string; sourceHash: string;
    conversationId: string; conversationStateHash: string; callId: string;
    classification: string; output: Record<string, unknown>; promptVersion: string;
    schemaVersion: string; policyVersion: string; model: string; createdAt: string;
    call?: ModelCallRecord; usage?: PreparedReasoningUsage; findings?: SemanticFinding[];
    workId?: string; leaseOwner?: string;
  }): void {
    const db = this.store.open();
    try {
      db.transaction(() => {
        db.query(`
          INSERT INTO imessage_extractions (
            extraction_id, source_id, message_id, source_hash, conversation_id,
            conversation_state_hash, call_id, classification, output_json,
            prompt_version, schema_version, policy_version, model, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.extractionId, input.sourceId, input.messageId, input.sourceHash,
          input.conversationId, input.conversationStateHash, input.callId,
          input.classification, JSON.stringify(input.output), input.promptVersion,
          input.schemaVersion, input.policyVersion, input.model, input.createdAt,
        );
        db.query(`
          UPDATE model_calls SET status = 'superseded', completed_at = ?
          WHERE workflow = 'imessage_extraction'
            AND task_type = 'subscription_imessage_extraction'
            AND source_hash = ? AND status = 'prepared' AND call_id <> ?
        `).run(input.createdAt, input.sourceHash, input.callId);
        if (input.call && input.findings && input.workId && input.leaseOwner) {
          saveFindingsInTransaction(db, input.findings);
          completeReasoningCallInTransaction(db, {
            call: input.call, ...(input.usage ? { usage: input.usage } : {}), completedAt: input.createdAt,
          });
          completeWorkInTransaction(db, {
            workId: input.workId, leaseOwner: input.leaseOwner,
            sourceHash: input.sourceHash, containerHash: input.conversationStateHash,
            completedAt: input.createdAt,
          });
        } else if (input.call || input.findings || input.workId || input.leaseOwner) {
          throw new Error("transactional Messages extraction completion is incomplete");
        }
      })();
    } finally {
      db.close();
    }
  }

  listExtractionsForFindingProjection(): ExtractionRecordForProjection[] {
    const db = this.store.open();
    try {
      return db.query<{
        extraction_id: string; call_id: string; output_json: string; created_at: string;
      }, []>(`
        SELECT extraction_id, call_id, output_json, created_at
        FROM imessage_extractions ORDER BY created_at, extraction_id
      `).all().map((row) => ({
        sourceType: "imessage_extraction",
        extractionId: row.extraction_id,
        callId: row.call_id,
        output: JSON.parse(row.output_json) as Record<string, unknown>,
        createdAt: row.created_at,
      }));
    } finally {
      db.close();
    }
  }

  saveDeterministicTriage(input: {
    triageId: string; sourceId: string; messageId: string; sourceHash: string;
    conversationId: string; conversationStateHash: string; classification: string;
    output: Record<string, unknown>; ruleVersion: string; createdAt: string;
    workId?: string; leaseOwner?: string;
  }): void {
    const db = this.store.open();
    try {
      db.transaction(() => {
        db.query(`
          INSERT INTO imessage_deterministic_triage (
            triage_id, source_id, message_id, source_hash, conversation_id,
            conversation_state_hash, classification, output_json, rule_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.triageId, input.sourceId, input.messageId, input.sourceHash,
          input.conversationId, input.conversationStateHash, input.classification,
          JSON.stringify(input.output), input.ruleVersion, input.createdAt,
        );
        if (input.workId && input.leaseOwner) completeWorkInTransaction(db, {
          workId: input.workId, leaseOwner: input.leaseOwner,
          sourceHash: input.sourceHash, containerHash: input.conversationStateHash,
          completedAt: input.createdAt,
        });
        else if (input.workId || input.leaseOwner) throw new Error("deterministic triage work lease is incomplete");
      })();
    } finally {
      db.close();
    }
  }

  extractionReview(sourceId: string, options: { now?: Date; timeZone?: string } = {}): {
    total: number; byClassification: Record<string, number>; actionable: number;
    unresolved: number; byKind: Record<string, number>;
    itemsByKind: Record<string, Array<Record<string, unknown>>>;
    focused: {
      needsReply: Array<Record<string, unknown>>; openLoops: Array<Record<string, unknown>>;
      upcomingDates: Array<Record<string, unknown>>; stalePlans: Array<Record<string, unknown>>;
      relationshipUpdates: Array<Record<string, unknown>>;
    };
    extractions: Array<{
      extractionId: string; classification: string; summary: string;
      source: "model" | "deterministic"; items: unknown[]; unresolved: string[];
      promptInjectionDetected: boolean; createdAt: string;
    }>;
  } {
    const db = this.store.open();
    try {
      const rows = db.query<{
        extraction_id: string; classification: string; output_json: string; created_at: string;
        source: "model" | "deterministic";
      }, [string, string]>(`
        SELECT extraction_id, classification, output_json, created_at, 'model' AS source
        FROM imessage_extractions WHERE source_id = ?
        UNION ALL
        SELECT triage_id AS extraction_id, classification, output_json, created_at,
          'deterministic' AS source
        FROM imessage_deterministic_triage WHERE source_id = ?
        ORDER BY created_at DESC
      `).all(sourceId, sourceId);
      const byClassification: Record<string, number> = {};
      const byKind: Record<string, number> = {};
      const itemsByKind: Record<string, Array<Record<string, unknown>>> = {};
      let unresolved = 0;
      const extractions = rows.map((row) => {
        const output = JSON.parse(row.output_json) as Record<string, unknown>;
        const unresolvedItems = Array.isArray(output.unresolved) ? output.unresolved.map(String) : [];
        byClassification[row.classification] = (byClassification[row.classification] ?? 0) + 1;
        unresolved += unresolvedItems.length;
        const sanitizedItems = Array.isArray(output.items) ? output.items.map(sanitizeReviewItem) : [];
        for (const item of sanitizedItems) {
          const kind = String(item.kind ?? "unknown");
          byKind[kind] = (byKind[kind] ?? 0) + 1;
          itemsByKind[kind] = [
            ...(itemsByKind[kind] ?? []),
            { ...item, extractionId: row.extraction_id, createdAt: row.created_at },
          ];
        }
        return {
          extractionId: row.extraction_id, classification: row.classification,
          source: row.source,
          summary: String(output.summary ?? ""),
          items: sanitizedItems,
          unresolved: unresolvedItems,
          promptInjectionDetected: output.promptInjectionDetected === true,
          createdAt: row.created_at,
        };
      });
      const allItems = Object.values(itemsByKind).flat();
      const today = localDate(options.now ?? new Date(), options.timeZone);
      const due = (item: Record<string, unknown>): string | null =>
        typeof item.dueDate === "string" ? item.dueDate.slice(0, 10) : null;
      return {
        total: extractions.length, byClassification,
        actionable: byClassification.actionable ?? 0, unresolved,
        byKind, itemsByKind,
        focused: {
          needsReply: allItems.filter((item) => item.responseNeeded === true
            || (item.responseNeeded === undefined && item.kind === "explicit_request"
              && /^(reply|respond|send\b)/i.test(String(item.statement ?? "")))),
          openLoops: allItems.filter((item) => ["open_loop", "user_commitment"].includes(String(item.kind))),
          upcomingDates: allItems.filter((item) => due(item) !== null && due(item)! >= today),
          stalePlans: allItems.filter((item) => due(item) !== null && due(item)! < today),
          relationshipUpdates: allItems.filter((item) => item.kind === "relationship_update"),
        },
        extractions,
      };
    } finally {
      db.close();
    }
  }

  startRun(input: { runId: string; sourceId: string; startedAt: string }): void {
    const db = this.store.open();
    try {
      db.query(`
        INSERT INTO imessage_ingestion_runs (
          ingestion_run_id, source_id, started_at, status
        ) VALUES (?, ?, ?, 'running')
      `).run(input.runId, input.sourceId, input.startedAt);
    } finally {
      db.close();
    }
  }

  saveBatch(input: {
    sourceId: string; messages: NormalizedIMessage[]; now: string; nextCursor: number;
  }): { ingested: number; unchanged: number; unavailableText: number } {
    const db = this.store.open();
    try {
      return db.transaction(() => {
        let ingested = 0;
        let unchanged = 0;
        let unavailableText = 0;
        const byConversation = new Map<string, NormalizedIMessage[]>();
        for (const message of input.messages) {
          const current = db.query<{ content_hash: string }, [string, string]>(
            "SELECT content_hash FROM imessage_messages WHERE source_id = ? AND message_id = ?",
          ).get(input.sourceId, message.messageId);
          if (current?.content_hash === message.contentHash) {
            unchanged += 1;
            continue;
          }
          if (!message.textAvailable) unavailableText += 1;
          db.query(`
            INSERT INTO imessage_messages (
              source_id, message_id, conversation_id, source_row_id, sent_at,
              direction, service, participant_set_hash, content_hash, text_hash,
              text_character_count, text_available, first_ingested_at, last_ingested_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id, message_id) DO UPDATE SET
              conversation_id = excluded.conversation_id,
              source_row_id = excluded.source_row_id,
              sent_at = excluded.sent_at,
              direction = excluded.direction,
              service = excluded.service,
              participant_set_hash = excluded.participant_set_hash,
              content_hash = excluded.content_hash,
              text_hash = excluded.text_hash,
              text_character_count = excluded.text_character_count,
              text_available = excluded.text_available,
              last_ingested_at = excluded.last_ingested_at
          `).run(
            input.sourceId, message.messageId, message.conversationId, message.sourceRowId,
            message.sentAt, message.direction, message.service, message.participantSetHash,
            message.contentHash, message.textHash, message.normalizedText.length,
            message.textAvailable ? 1 : 0, input.now, input.now,
          );
          db.query(`
            INSERT OR IGNORE INTO imessage_message_versions (
              source_id, message_id, content_hash, conversation_id, source_row_id,
              text_hash, participant_set_hash, normalizer_version,
              text_character_count, text_available, discovered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            input.sourceId, message.messageId, message.contentHash, message.conversationId,
            message.sourceRowId, message.textHash, message.participantSetHash,
            imessageNormalizerVersion, message.normalizedText.length,
            message.textAvailable ? 1 : 0, input.now,
          );
          byConversation.set(message.conversationId, [
            ...(byConversation.get(message.conversationId) ?? []), message,
          ]);
          ingested += 1;
        }
        for (const [conversationId, messages] of byConversation) {
          this.refreshConversation(db, input.sourceId, conversationId, messages.at(-1)!.service, input.now);
          const work = db.query<{
            message_id: string; content_hash: string; conversation_state_hash: string;
          }, [string, string]>(`
            SELECT message.message_id, message.content_hash, conversation.conversation_state_hash
            FROM imessage_conversations conversation JOIN imessage_messages message
              ON message.source_id = conversation.source_id
                AND message.conversation_id = conversation.conversation_id
            WHERE conversation.source_id = ? AND conversation.conversation_id = ?
              AND message.text_available = 1 AND message.text_character_count > 0
            ORDER BY message.sent_at DESC, message.source_row_id DESC LIMIT 1
          `).get(input.sourceId, conversationId);
          if (work) enqueueWorkInTransaction(db, {
            workflow: "imessage_extraction", subjectType: "imessage_conversation",
            subjectSourceId: input.sourceId, subjectId: conversationId,
            anchorId: work.message_id, sourceHash: work.content_hash,
            containerHash: work.conversation_state_hash, reason: "source_delta", now: input.now,
          });
        }
        db.query(`
          UPDATE imessage_sources SET last_row_id = MAX(last_row_id, ?), updated_at = ?
          WHERE source_id = ?
        `).run(input.nextCursor, input.now, input.sourceId);
        return { ingested, unchanged, unavailableText };
      })();
    } finally {
      db.close();
    }
  }

  finishRun(input: {
    runId: string; completedAt: string; status: "completed" | "failed";
    discovered: number; ingested: number; unchanged: number; unavailableText: number;
    error?: string;
  }): void {
    const db = this.store.open();
    try {
      db.query(`
        UPDATE imessage_ingestion_runs SET completed_at = ?, status = ?,
          discovered_count = ?, ingested_count = ?, unchanged_count = ?,
          unavailable_text_count = ?, error = ?
        WHERE ingestion_run_id = ?
      `).run(
        input.completedAt, input.status, input.discovered, input.ingested,
        input.unchanged, input.unavailableText, input.error ?? null, input.runId,
      );
    } finally {
      db.close();
    }
  }

  inspectionSummary(sourceId: string): {
    configured: boolean; cursor: number; conversations: number; messages: number;
    versions: number; extractions: number; modelExtractions: number;
    deterministicTriaged: number; pendingConversations: number;
    unavailableText: number; unprocessed: number;
    ingestionRuns: number; lastRunStatus: string | null; lastRunCompletedAt: string | null;
  } {
    const db = this.store.open();
    try {
      const source = db.query<{ last_row_id: number }, [string]>(
        "SELECT last_row_id FROM imessage_sources WHERE source_id = ?",
      ).get(sourceId);
      const messages = db.query<{
        count: number; unavailable: number; unprocessed: number;
      }, [string]>(`
        SELECT COUNT(*) AS count,
          COALESCE(SUM(CASE WHEN text_available = 0 THEN 1 ELSE 0 END), 0) AS unavailable,
          COALESCE(SUM(CASE WHEN m.sent_at > COALESCE((SELECT MAX(processed.sent_at) FROM (
            SELECT previous.sent_at AS sent_at
            FROM imessage_extractions e JOIN imessage_messages previous
              ON previous.source_id = e.source_id AND previous.message_id = e.message_id
            WHERE e.source_id = m.source_id AND e.conversation_id = m.conversation_id
            UNION ALL
            SELECT previous.sent_at AS sent_at
            FROM imessage_deterministic_triage t JOIN imessage_messages previous
              ON previous.source_id = t.source_id AND previous.message_id = t.message_id
            WHERE t.source_id = m.source_id AND t.conversation_id = m.conversation_id
          ) processed
          ), '') THEN 1 ELSE 0 END), 0) AS unprocessed
        FROM imessage_messages m WHERE source_id = ?
      `).get(sourceId);
      const count = (table: string): number => db.query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE source_id = ?`,
      ).get(sourceId)?.count ?? 0;
      const lastRun = db.query<{ status: string; completed_at: string | null }, [string]>(`
        SELECT status, completed_at FROM imessage_ingestion_runs
        WHERE source_id = ? ORDER BY started_at DESC LIMIT 1
      `).get(sourceId);
      return {
        configured: Boolean(source), cursor: source?.last_row_id ?? 0,
        conversations: count("imessage_conversations"), messages: messages?.count ?? 0,
        versions: count("imessage_message_versions"),
        extractions: count("imessage_extractions") + count("imessage_deterministic_triage"),
        modelExtractions: count("imessage_extractions"),
        deterministicTriaged: count("imessage_deterministic_triage"),
        pendingConversations: db.query<{ count: number }, [string]>(`
          SELECT COUNT(DISTINCT subject_id) AS count FROM work_items
          WHERE workflow = 'imessage_extraction' AND subject_source_id = ?
            AND state IN ('pending', 'leased')
        `).get(sourceId)?.count ?? 0,
        unavailableText: messages?.unavailable ?? 0, unprocessed: messages?.unprocessed ?? 0,
        ingestionRuns: count("imessage_ingestion_runs"),
        lastRunStatus: lastRun?.status ?? null,
        lastRunCompletedAt: lastRun?.completed_at ?? null,
      };
    } finally {
      db.close();
    }
  }

  private refreshConversation(
    db: ReturnType<OperationalStore["open"]>, sourceId: string,
    conversationId: string, service: string, now: string,
  ): void {
    const rows = db.query<{
      message_id: string; content_hash: string; participant_set_hash: string; sent_at: string;
    }, [string, string]>(`
      SELECT message_id, content_hash, participant_set_hash, sent_at
      FROM imessage_messages WHERE source_id = ? AND conversation_id = ?
      ORDER BY sent_at, source_row_id
    `).all(sourceId, conversationId);
    const latest = rows.at(-1)!;
    const stateHash = sha256Value(rows.map((row) => [row.message_id, row.content_hash]));
    db.query(`
      INSERT INTO imessage_conversations (
        source_id, conversation_id, participant_set_hash, conversation_state_hash,
        service, message_count, latest_message_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, conversation_id) DO UPDATE SET
        participant_set_hash = excluded.participant_set_hash,
        conversation_state_hash = excluded.conversation_state_hash,
        service = excluded.service,
        message_count = excluded.message_count,
        latest_message_at = excluded.latest_message_at,
        updated_at = excluded.updated_at
    `).run(
      sourceId, conversationId, latest.participant_set_hash, stateHash,
      service, rows.length, latest.sent_at, now,
    );
  }
}

function localDate(date: Date, timeZone?: string): string {
  if (!timeZone) return date.toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function sanitizeReviewItem(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries([
    ...Object.entries(record).filter(([key]) => key !== "evidenceIds"),
    ["evidenceCount", Array.isArray(record.evidenceIds) ? record.evidenceIds.length : 0],
  ]);
}
