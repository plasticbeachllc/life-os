import type { OperationalStore } from "../db/store";
import type { NormalizedTelegramMessage } from "./normalizer";
import { telegramNormalizerVersion } from "./normalizer";

export class TelegramStore {
  constructor(private readonly store: OperationalStore) {}

  ensureSource(input: { sourceId: string; now: string }): void {
    const db = this.store.open();
    try {
      db.query(`INSERT INTO telegram_sources (source_id, normalizer_version, created_at, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET
        normalizer_version=excluded.normalizer_version, updated_at=excluded.updated_at`)
        .run(input.sourceId, telegramNormalizerVersion, input.now, input.now);
    } finally { db.close(); }
  }

  startRun(input: { runId: string; sourceId: string; startedAt: string }): void {
    const db = this.store.open();
    try {
      db.query(`INSERT INTO telegram_ingestion_runs
        (ingestion_run_id, source_id, started_at, status) VALUES (?, ?, ?, 'running')`)
        .run(input.runId, input.sourceId, input.startedAt);
    } finally { db.close(); }
  }

  finishRun(input: { runId: string; completedAt: string; status: "completed" | "failed";
    discovered: number; ingested: number; unchanged: number; unavailableText: number; error?: string }): void {
    const db = this.store.open();
    try {
      db.query(`UPDATE telegram_ingestion_runs SET completed_at=?, status=?, discovered_count=?,
        ingested_count=?, unchanged_count=?, unavailable_text_count=?, error=? WHERE ingestion_run_id=?`)
        .run(input.completedAt, input.status, input.discovered, input.ingested, input.unchanged,
          input.unavailableText, input.error ?? null, input.runId);
    } finally { db.close(); }
  }

  cursors(sourceId: string, chatHashes: string[]): Record<string, string> {
    if (chatHashes.length === 0) return {};
    const db = this.store.open();
    try {
      const placeholders = chatHashes.map(() => "?").join(",");
      const rows = db.query<{ source_chat_id_hash: string; last_source_message_id: string }, string[]>(
        `SELECT source_chat_id_hash, last_source_message_id FROM telegram_chat_cursors
         WHERE source_id=? AND source_chat_id_hash IN (${placeholders})`,
      ).all(sourceId, ...chatHashes);
      return Object.fromEntries(rows.map((row) => [row.source_chat_id_hash, row.last_source_message_id]));
    } finally { db.close(); }
  }

  saveBatch(input: { sourceId: string; messages: NormalizedTelegramMessage[]; now: string }): {
    ingested: number; unchanged: number; unavailableText: number;
  } {
    const db = this.store.open();
    try {
      return db.transaction(() => {
        let ingested = 0; let unchanged = 0; let unavailableText = 0;
        for (const message of input.messages) {
          if (!message.textAvailable) unavailableText += 1;
          const current = db.query<{ content_hash: string }, [string, string]>(
            "SELECT content_hash FROM telegram_messages WHERE source_id=? AND message_id=?",
          ).get(input.sourceId, message.messageId);
          if (current?.content_hash === message.contentHash) {
            unchanged += 1;
          } else {
            db.query(`INSERT INTO telegram_messages (
              source_id, message_id, chat_id, source_message_id, sent_at, edited_at, direction,
              sender_type, sender_hash, content_type, content_hash, current_version_hash,
              ingestion_state, first_ingested_at, last_ingested_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ingested', ?, ?)
            ON CONFLICT(source_id, message_id) DO UPDATE SET edited_at=excluded.edited_at,
              direction=excluded.direction, sender_type=excluded.sender_type,
              sender_hash=excluded.sender_hash, content_type=excluded.content_type,
              content_hash=excluded.content_hash, current_version_hash=excluded.current_version_hash,
              ingestion_state='ingested', last_ingested_at=excluded.last_ingested_at`)
              .run(input.sourceId, message.messageId, message.chatId, message.sourceMessageId,
                message.sentAt, message.editedAt, message.direction, message.senderType,
                message.senderHash, message.contentType, message.contentHash, message.contentHash,
                input.now, input.now);
            db.query(`INSERT OR IGNORE INTO telegram_message_versions (
              source_id, message_id, content_hash, text_hash, text_available,
              character_count, normalizer_version, discovered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(input.sourceId, message.messageId, message.contentHash, message.textHash,
                message.textAvailable ? 1 : 0, message.characterCount, telegramNormalizerVersion, input.now);
            ingested += 1;
          }
          const priorCursor = db.query<{ last_source_message_id: string }, [string, string]>(
            "SELECT last_source_message_id FROM telegram_chat_cursors WHERE source_id=? AND chat_id=?",
          ).get(input.sourceId, message.chatId)?.last_source_message_id ?? "0";
          const nextCursor = BigInt(message.sourceMessageId) > BigInt(priorCursor)
            ? message.sourceMessageId : priorCursor;
          db.query(`INSERT INTO telegram_chat_cursors
            (source_id, chat_id, source_chat_id_hash, last_source_message_id, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_id, chat_id) DO UPDATE SET
            last_source_message_id=excluded.last_source_message_id, updated_at=excluded.updated_at`)
            .run(input.sourceId, message.chatId, message.sourceChatIdHash, nextCursor, input.now);
        }
        return { ingested, unchanged, unavailableText };
      })();
    } finally { db.close(); }
  }

  status(sourceId: string): { configured: boolean; chats: number; messages: number; versions: number;
    extractionSupported: false; ingestionRuns: number; lastRunStatus: string | null; unavailableText: number } {
    const db = this.store.open();
    try {
      const configured = Boolean(db.query("SELECT 1 FROM telegram_sources WHERE source_id=?").get(sourceId));
      const chats = db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) count FROM telegram_chat_cursors WHERE source_id=?",
      ).get(sourceId)?.count ?? 0;
      const messages = db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) count FROM telegram_messages WHERE source_id=?",
      ).get(sourceId);
      const versions = db.query<{ count: number; unavailable: number }, [string]>(`SELECT COUNT(*) count,
        COALESCE(SUM(CASE WHEN text_available=0 THEN 1 ELSE 0 END),0) unavailable
        FROM telegram_message_versions WHERE source_id=?`).get(sourceId);
      const runs = db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) count FROM telegram_ingestion_runs WHERE source_id=?",
      ).get(sourceId)?.count ?? 0;
      const last = db.query<{ status: string }, [string]>(
        "SELECT status FROM telegram_ingestion_runs WHERE source_id=? ORDER BY started_at DESC LIMIT 1",
      ).get(sourceId);
      return { configured, chats, messages: messages?.count ?? 0, versions: versions?.count ?? 0,
        extractionSupported: false, ingestionRuns: runs,
        lastRunStatus: last?.status ?? null, unavailableText: versions?.unavailable ?? 0 };
    } finally { db.close(); }
  }
}
