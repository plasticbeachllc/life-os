import type { IMessageConversationSelection, IMessageSourceAdapter } from "../adapters/imessage";
import type { OperationalStore } from "../db/store";
import { normalizeIMessage } from "../imessage/normalizer";
import { IMessageStore } from "../imessage/store";

export async function refetchIMessage(input: {
  adapter: IMessageSourceAdapter; store: OperationalStore; sourceId: string;
  messageId: string; selection: IMessageConversationSelection;
}): Promise<{
  messageId: string; conversationId: string; sentAt: string;
  direction: "incoming" | "outgoing"; service: string;
  transientText: string; sourceHash: string; participantSetHash: string;
}> {
  input.store.migrate();
  const stored = new IMessageStore(input.store).sourceIdentity(input.sourceId, input.messageId);
  if (!stored) throw new Error("ingested Messages source not found");
  const source = await input.adapter.getMessageByRowId({
    sourceRowId: stored.sourceRowId, selection: input.selection,
  });
  if (!source) throw new Error("Messages source is no longer selected or available");
  const current = normalizeIMessage(source);
  if (current.messageId !== stored.messageId || current.conversationId !== stored.conversationId
    || current.contentHash !== stored.contentHash
    || current.participantSetHash !== stored.participantSetHash) {
    throw new Error("Messages source or conversation changed; ingest again before refetching");
  }
  if (!current.textAvailable) throw new Error("Messages source text could not be decoded");
  return {
    messageId: current.messageId, conversationId: current.conversationId,
    sentAt: current.sentAt, direction: current.direction, service: current.service,
    transientText: current.normalizedText, sourceHash: current.contentHash,
    participantSetHash: current.participantSetHash,
  };
}
