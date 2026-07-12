import type { IMessageSourceMessage } from "../adapters/imessage";
import { sha256Text, sha256Value } from "../util/hashing";

export const imessageNormalizerVersion = "imessage-normalizer-v1";
const appleEpochMilliseconds = Date.UTC(2001, 0, 1);

export interface NormalizedIMessage {
  messageId: string;
  conversationId: string;
  sourceRowId: number;
  sentAt: string;
  direction: "incoming" | "outgoing";
  service: string;
  normalizedText: string;
  textAvailable: boolean;
  textHash: string;
  participantSetHash: string;
  contentHash: string;
}

export function normalizeIMessage(message: IMessageSourceMessage): NormalizedIMessage {
  if (!message.sourceMessageId || !message.sourceConversationId || message.sourceRowId < 1) {
    throw new Error("iMessage source message requires stable message, conversation, and row identifiers");
  }
  const normalizedText = normalizeText(message.text ?? "");
  const textAvailable = message.text !== null || !message.attributedBodyPresent;
  const messageId = internalId("imsg", message.sourceMessageId);
  const conversationId = internalId("imchat", message.sourceConversationId);
  const textHash = sha256Text(normalizedText);
  const participantSetHash = sha256Value([...message.participants].sort());
  const sentAt = appleDateToIso(message.appleDate);
  const direction = message.fromMe ? "outgoing" : "incoming";
  const contentHash = sha256Value({
    messageId,
    conversationId,
    sourceRowId: message.sourceRowId,
    sentAt,
    direction,
    service: message.service,
    textHash,
    attributedBodyHash: message.attributedBodyHash,
    textAvailable,
    participantSetHash,
    normalizerVersion: imessageNormalizerVersion,
  });
  return {
    messageId, conversationId,
    sourceRowId: message.sourceRowId, sentAt, direction, service: message.service,
    normalizedText, textAvailable, textHash, participantSetHash, contentHash,
  };
}

export function internalIMessageConversationId(sourceConversationId: string): string {
  if (!sourceConversationId || sourceConversationId.length > 512 || /[\u0000-\u001f]/.test(sourceConversationId)) {
    throw new Error("invalid source Messages conversation ID");
  }
  return internalId("imchat", sourceConversationId);
}

function internalId(prefix: "imsg" | "imchat", sourceId: string): string {
  return `${prefix}_${sha256Text(sourceId).slice("sha256:".length)}`;
}

export function appleDateToIso(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid Apple message timestamp");
  const seconds = value > 10_000_000_000 ? value / 1_000_000_000 : value;
  const date = new Date(appleEpochMilliseconds + seconds * 1000);
  if (Number.isNaN(date.getTime())) throw new Error("invalid Apple message timestamp");
  return date.toISOString();
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}
