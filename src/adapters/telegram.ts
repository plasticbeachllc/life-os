export interface TdLibMessageContent {
  "@type": string;
  text?: { text?: string };
  caption?: { text?: string };
}

export interface TdLibMessage {
  id: number;
  chat_id: number;
  date: number;
  edit_date?: number;
  is_outgoing: boolean;
  sender_id?: { "@type": string; user_id?: number; chat_id?: number };
  content: TdLibMessageContent;
}

export interface TelegramSourceMessage {
  sourceMessageId: string;
  sourceChatId: string;
  sentAtUnix: number;
  editedAtUnix: number | null;
  outgoing: boolean;
  senderType: string;
  senderId: string | null;
  contentType: string;
  text: string | null;
}

export interface TelegramSourceAdapter {
  checkReady(): Promise<{ ok: boolean; authorizationState: string }>;
  listMessageChanges(input: {
    chatIds: string[];
    afterMessageIds: Record<string, string>;
    limitPerChat: number;
  }): Promise<TelegramSourceMessage[]>;
  getMessage(input: { chatId: string; messageId: string }): Promise<TelegramSourceMessage | undefined>;
}

export interface TdLibJsonClient {
  request<T extends Record<string, unknown>>(request: Record<string, unknown>): Promise<T>;
  authorizationState(): Promise<string>;
}

/** Narrow TDLib adapter. The client owns authorization and TDLib's encrypted database. */
export class TdLibTelegramAdapter implements TelegramSourceAdapter {
  constructor(private readonly client: TdLibJsonClient) {}

  async checkReady(): Promise<{ ok: boolean; authorizationState: string }> {
    const authorizationState = await this.client.authorizationState();
    return { ok: authorizationState === "authorizationStateReady", authorizationState };
  }

  async listMessageChanges(input: {
    chatIds: string[]; afterMessageIds: Record<string, string>; limitPerChat: number;
  }): Promise<TelegramSourceMessage[]> {
    assertSelection(input.chatIds);
    if (!Number.isInteger(input.limitPerChat) || input.limitPerChat < 1 || input.limitPerChat > 100) {
      throw new Error("Telegram history limit must be between 1 and 100");
    }
    const collected: TelegramSourceMessage[] = [];
    for (const chatId of input.chatIds) {
      const cursor = BigInt(input.afterMessageIds[chatId] ?? "0");
      let fromMessageId = 0;
      let reachedCursor = cursor === 0n;
      const chatMessages: TelegramSourceMessage[] = [];
      for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
        const response = await this.client.request<{ messages?: TdLibMessage[] }>({
          "@type": "getChatHistory", chat_id: parseTdId(chatId, "chat"), from_message_id: fromMessageId,
          offset: 0, limit: Math.min(100, input.limitPerChat), only_local: false,
        });
        const page = response.messages ?? [];
        if (page.length === 0) { reachedCursor = true; break; }
        for (const message of page) {
          const messageId = BigInt(message.id);
          if (messageId <= cursor) reachedCursor = true;
          if (messageId > cursor || (message.edit_date ?? 0) > 0) chatMessages.push(projectMessage(message));
        }
        if (cursor === 0n || reachedCursor) break;
        const oldest = page.at(-1);
        if (!oldest || oldest.id === fromMessageId) break;
        fromMessageId = oldest.id;
      }
      if (!reachedCursor) {
        throw new Error("Telegram history delta exceeds the bounded 20-page synchronization window");
      }
      chatMessages.sort((left, right) => compareMessages(left, right));
      collected.push(...chatMessages.slice(0, input.limitPerChat));
    }
    return collected.sort(compareMessages);
  }

  async getMessage(input: { chatId: string; messageId: string }): Promise<TelegramSourceMessage | undefined> {
    try {
      const message = await this.client.request<TdLibMessage & Record<string, unknown>>({
        "@type": "getMessage", chat_id: parseTdId(input.chatId, "chat"),
        message_id: parseTdId(input.messageId, "message"),
      });
      return projectMessage(message);
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) return undefined;
      throw error;
    }
  }
}

function compareMessages(left: TelegramSourceMessage, right: TelegramSourceMessage): number {
  const dateOrder = left.sentAtUnix - right.sentAtUnix;
  if (dateOrder !== 0) return dateOrder;
  const leftId = BigInt(left.sourceMessageId); const rightId = BigInt(right.sourceMessageId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function projectMessage(message: TdLibMessage): TelegramSourceMessage {
  if (!message.id || !message.chat_id || !message.content?.["@type"]) {
    throw new Error("TDLib returned a message without stable identifiers or content type");
  }
  const sender = message.sender_id;
  const senderId = sender?.user_id ?? sender?.chat_id;
  return {
    sourceMessageId: String(message.id), sourceChatId: String(message.chat_id),
    sentAtUnix: message.date, editedAtUnix: message.edit_date ? message.edit_date : null,
    outgoing: message.is_outgoing, senderType: sender?.["@type"] ?? "unknown",
    senderId: senderId === undefined ? null : String(senderId),
    contentType: message.content["@type"],
    text: message.content.text?.text ?? message.content.caption?.text ?? null,
  };
}

function assertSelection(chatIds: string[]): void {
  if (chatIds.length === 0) throw new Error("Telegram ingestion requires an explicit chat allowlist");
  if (chatIds.length > 100) throw new Error("Telegram chat allowlist is limited to 100 chats");
  for (const id of chatIds) parseTdId(id, "chat");
}

function parseTdId(value: string, kind: string): number {
  if (!/^-?[1-9]\d*$/.test(value)) throw new Error(`invalid TDLib ${kind} identifier`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`TDLib ${kind} identifier exceeds JavaScript safe range`);
  return parsed;
}
