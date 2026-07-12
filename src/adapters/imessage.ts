import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  MacOsAttributedBodyDecoder, type AttributedBodyDecoder,
} from "../imessage/attributed-body";

export interface IMessageConversation {
  sourceConversationId: string;
  displayName: string | null;
  service: string;
  participants: string[];
  latestSourceRowId: number;
}

export interface IMessageSourceMessage {
  sourceRowId: number;
  sourceMessageId: string;
  sourceConversationId: string;
  appleDate: number;
  fromMe: boolean;
  service: string;
  text: string | null;
  attributedBodyPresent: boolean;
  attributedBodyHash: string | null;
  participants: string[];
}

export interface IMessageSourceAdapter {
  checkAccess(): Promise<{ ok: boolean; reason?: string }>;
  listConversations(limit: number): Promise<IMessageConversation[]>;
  listMessageChanges(input: {
    afterRowId: number; selection: IMessageConversationSelection; limit: number;
  }): Promise<IMessageSourceMessage[]>;
  getMessageByRowId(input: {
    sourceRowId: number; selection: IMessageConversationSelection;
  }): Promise<IMessageSourceMessage | undefined>;
  getConversationWindow(input: {
    sourceRowId: number; selection: IMessageConversationSelection; limit: number;
  }): Promise<IMessageSourceMessage[]>;
}

export type IMessageConversationSelection =
  | { mode: "allowlist"; conversationIds: string[] }
  | { mode: "all_except"; conversationIds: string[] };

interface ConversationRow {
  guid: string; display_name: string | null; service_name: string | null;
  participants: string | null; latest_row_id: number | null;
}

interface MessageRow {
  row_id: number; message_guid: string; chat_guid: string; date: number;
  is_from_me: number; service: string | null; text: string | null;
  attributed_body: Uint8Array | null; participants: string | null;
}

const requiredTables = ["chat", "message", "chat_message_join", "handle", "chat_handle_join"];

export class MacOsMessagesAdapter implements IMessageSourceAdapter {
  constructor(
    readonly databasePath: string,
    private readonly attributedBodyDecoder: AttributedBodyDecoder = new MacOsAttributedBodyDecoder(),
  ) {}

  async checkAccess(): Promise<{ ok: boolean; reason?: string }> {
    if (!existsSync(this.databasePath)) return { ok: false, reason: "Messages database not found" };
    try {
      const db = this.open();
      try {
        const tables = new Set(db.query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).all().map((row) => row.name));
        const missing = requiredTables.filter((table) => !tables.has(table));
        return missing.length === 0
          ? { ok: true }
          : { ok: false, reason: `unsupported Messages database schema; missing: ${missing.join(", ")}` };
      } finally {
        db.close();
      }
    } catch (error) {
      return { ok: false, reason: accessError(error) };
    }
  }

  async listConversations(limit: number): Promise<IMessageConversation[]> {
    const db = this.open();
    try {
      return db.query<ConversationRow, [number]>(`
        SELECT c.guid, c.display_name, c.service_name,
          GROUP_CONCAT(DISTINCT h.id) AS participants,
          MAX(m.ROWID) AS latest_row_id
        FROM chat c
        LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
        LEFT JOIN handle h ON h.ROWID = chj.handle_id
        LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
        LEFT JOIN message m ON m.ROWID = cmj.message_id
        WHERE c.guid IS NOT NULL
        GROUP BY c.ROWID
        ORDER BY latest_row_id DESC
        LIMIT ?
      `).all(limit).map((row) => ({
        sourceConversationId: row.guid,
        displayName: row.display_name,
        service: row.service_name ?? "unknown",
        participants: splitParticipants(row.participants),
        latestSourceRowId: row.latest_row_id ?? 0,
      }));
    } finally {
      db.close();
    }
  }

  async listMessageChanges(input: {
    afterRowId: number; selection: IMessageConversationSelection; limit: number;
  }): Promise<IMessageSourceMessage[]> {
    const ids = input.selection.conversationIds;
    if (input.selection.mode === "allowlist" && ids.length === 0) return [];
    if (ids.length > 100) throw new Error("too many configured conversation identifiers");
    const placeholders = ids.map(() => "?").join(", ");
    const selectionClause = input.selection.mode === "allowlist"
      ? `AND c.guid IN (${placeholders})`
      : ids.length > 0 ? `AND c.guid NOT IN (${placeholders})` : "";
    const order = input.afterRowId === 0 ? "DESC" : "ASC";
    const db = this.open();
    try {
      const rows = db.query<MessageRow, Array<string | number>>(`
        SELECT m.ROWID AS row_id, m.guid AS message_guid, c.guid AS chat_guid,
          m.date, m.is_from_me, COALESCE(m.service, c.service_name) AS service,
          m.text, m.attributedBody AS attributed_body,
          (SELECT GROUP_CONCAT(DISTINCT h.id)
             FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
            WHERE chj.chat_id = c.ROWID) AS participants
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE m.ROWID > ? ${selectionClause}
        ORDER BY m.ROWID ${order}
        LIMIT ?
      `).all(input.afterRowId, ...ids, input.limit);
      const chronological = input.afterRowId === 0 ? rows.reverse() : rows;
      return await this.toSourceMessages(chronological);
    } finally {
      db.close();
    }
  }

  async getMessageByRowId(input: {
    sourceRowId: number; selection: IMessageConversationSelection;
  }): Promise<IMessageSourceMessage | undefined> {
    if (!Number.isSafeInteger(input.sourceRowId) || input.sourceRowId < 1) {
      throw new Error("invalid Messages source row identifier");
    }
    const ids = input.selection.conversationIds;
    if (input.selection.mode === "allowlist" && ids.length === 0) return undefined;
    if (ids.length > 100) throw new Error("too many configured conversation identifiers");
    const placeholders = ids.map(() => "?").join(", ");
    const selectionClause = input.selection.mode === "allowlist"
      ? `AND c.guid IN (${placeholders})`
      : ids.length > 0 ? `AND c.guid NOT IN (${placeholders})` : "";
    const db = this.open();
    try {
      const row = db.query<MessageRow, Array<string | number>>(`
        SELECT m.ROWID AS row_id, m.guid AS message_guid, c.guid AS chat_guid,
          m.date, m.is_from_me, COALESCE(m.service, c.service_name) AS service,
          m.text, m.attributedBody AS attributed_body,
          (SELECT GROUP_CONCAT(DISTINCT h.id)
             FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
            WHERE chj.chat_id = c.ROWID) AS participants
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE m.ROWID = ? ${selectionClause}
        LIMIT 1
      `).get(input.sourceRowId, ...ids);
      return row ? (await this.toSourceMessages([row]))[0] : undefined;
    } finally {
      db.close();
    }
  }

  async getConversationWindow(input: {
    sourceRowId: number; selection: IMessageConversationSelection; limit: number;
  }): Promise<IMessageSourceMessage[]> {
    if (!Number.isSafeInteger(input.sourceRowId) || input.sourceRowId < 1) {
      throw new Error("invalid Messages source row identifier");
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) {
      throw new Error("Messages conversation window limit must be between 1 and 20");
    }
    const ids = input.selection.conversationIds;
    if (input.selection.mode === "allowlist" && ids.length === 0) return [];
    if (ids.length > 100) throw new Error("too many configured conversation identifiers");
    const placeholders = ids.map(() => "?").join(", ");
    const selectionClause = input.selection.mode === "allowlist"
      ? `AND selected_chat.guid IN (${placeholders})`
      : ids.length > 0 ? `AND selected_chat.guid NOT IN (${placeholders})` : "";
    const db = this.open();
    try {
      const rows = db.query<MessageRow, Array<string | number>>(`
        SELECT m.ROWID AS row_id, m.guid AS message_guid, c.guid AS chat_guid,
          m.date, m.is_from_me, COALESCE(m.service, c.service_name) AS service,
          m.text, m.attributedBody AS attributed_body,
          (SELECT GROUP_CONCAT(DISTINCT h.id)
             FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
            WHERE chj.chat_id = c.ROWID) AS participants
        FROM message selected_message
        JOIN chat_message_join selected_join ON selected_join.message_id = selected_message.ROWID
        JOIN chat selected_chat ON selected_chat.ROWID = selected_join.chat_id
        JOIN chat_message_join cmj ON cmj.chat_id = selected_chat.ROWID
        JOIN message m ON m.ROWID = cmj.message_id
        JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE selected_message.ROWID = ? ${selectionClause}
          AND (m.date < selected_message.date
            OR (m.date = selected_message.date AND m.ROWID <= selected_message.ROWID))
        ORDER BY m.date DESC, m.ROWID DESC LIMIT ?
      `).all(input.sourceRowId, ...ids, input.limit);
      return this.toSourceMessages(rows.reverse());
    } finally {
      db.close();
    }
  }

  private async toSourceMessages(rows: MessageRow[]): Promise<IMessageSourceMessage[]> {
    const bodies = rows.flatMap((row) => row.text === null && row.attributed_body?.byteLength
      ? [row.attributed_body] : []);
    const decoded = await this.attributedBodyDecoder.decode(bodies);
    let decodedIndex = 0;
    return rows.map((row) => {
      const attributedBodyPresent = Boolean(row.attributed_body?.byteLength);
      const decodedText = row.text === null && attributedBodyPresent
        ? decoded[decodedIndex++] ?? null : row.text;
      return {
        sourceRowId: row.row_id, sourceMessageId: row.message_guid,
        sourceConversationId: row.chat_guid, appleDate: row.date,
        fromMe: Boolean(row.is_from_me), service: row.service ?? "unknown",
        text: decodedText, attributedBodyPresent,
        attributedBodyHash: attributedBodyPresent
          ? `sha256:${createHash("sha256").update(row.attributed_body!).digest("hex")}` : null,
        participants: splitParticipants(row.participants),
      };
    });
  }

  private open(): Database {
    try {
      return new Database(this.databasePath, { readonly: true, strict: true });
    } catch (error) {
      throw new Error(accessError(error));
    }
  }
}

function splitParticipants(value: string | null): string[] {
  return value ? [...new Set(value.split(",").filter(Boolean))].sort() : [];
}

function accessError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.startsWith("cannot read Messages database;")) return detail;
  return `cannot read Messages database; grant Full Disk Access to the Life OS host (${detail})`;
}
