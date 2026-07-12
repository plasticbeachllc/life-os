import type { TelegramSourceMessage } from "../adapters/telegram";
import { sha256Text, sha256Value } from "../util/hashing";

export const telegramNormalizerVersion = "telegram-normalizer-v1";

export interface NormalizedTelegramMessage {
  messageId: string;
  chatId: string;
  sourceMessageId: string;
  sourceChatIdHash: string;
  sentAt: string;
  editedAt: string | null;
  direction: "incoming" | "outgoing";
  senderType: string;
  senderHash: string | null;
  contentType: string;
  textHash: string;
  textAvailable: boolean;
  characterCount: number;
  contentHash: string;
}

export function normalizeTelegramMessage(source: TelegramSourceMessage): NormalizedTelegramMessage {
  const text = normalizeText(source.text ?? "");
  const sourceChatIdHash = sha256Text(source.sourceChatId);
  const chatId = `tgchat_${sourceChatIdHash.slice("sha256:".length)}`;
  const messageId = `tgmsg_${sha256Text(`${source.sourceChatId}:${source.sourceMessageId}`).slice("sha256:".length)}`;
  const sentAt = unixToIso(source.sentAtUnix);
  const editedAt = source.editedAtUnix === null ? null : unixToIso(source.editedAtUnix);
  const direction: NormalizedTelegramMessage["direction"] = source.outgoing ? "outgoing" : "incoming";
  const senderHash = source.senderId === null ? null : sha256Text(`${source.senderType}:${source.senderId}`);
  const textHash = sha256Text(text);
  const value = {
    messageId, chatId, sourceMessageId: source.sourceMessageId, sourceChatIdHash,
    sentAt, editedAt, direction, senderType: source.senderType, senderHash,
    contentType: source.contentType, textHash, textAvailable: source.text !== null,
    characterCount: text.length, normalizerVersion: telegramNormalizerVersion,
  };
  return { ...value, contentHash: sha256Value(value) };
}

function unixToIso(value: number): string {
  if (!Number.isInteger(value) || value < 1) throw new Error("invalid Telegram timestamp");
  return new Date(value * 1000).toISOString();
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}
