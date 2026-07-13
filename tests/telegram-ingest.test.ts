import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TdLibTelegramAdapter, type TdLibJsonClient, type TelegramSourceAdapter,
  type TelegramSourceMessage } from "../src/adapters/telegram";
import { OperationalStore } from "../src/db/store";
import { normalizeTelegramMessage } from "../src/telegram/normalizer";
import { TelegramStore } from "../src/telegram/store";
import { ingestTelegramChanges } from "../src/workflows/telegram-ingest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function database(): { path: string; store: OperationalStore } {
  const root = mkdtempSync(join(tmpdir(), "life-os-telegram-")); roots.push(root);
  const path = join(root, "state.db");
  return { path, store: new OperationalStore(path) };
}

const sourceMessage = (text = "Meet at 5 near Central Park"): TelegramSourceMessage => ({
  sourceMessageId: "1048576", sourceChatId: "-1001234567890", sentAtUnix: 1_750_000_000,
  editedAtUnix: null, outgoing: false, senderType: "messageSenderUser",
  senderId: "998877", contentType: "messageText", text,
});

class FakeAdapter implements TelegramSourceAdapter {
  constructor(public messages: TelegramSourceMessage[], private readonly ready = true) {}
  checkReady = async () => ({ ok: this.ready,
    authorizationState: this.ready ? "authorizationStateReady" : "authorizationStateWaitCode" });
  async listMessageChanges(input: { chatIds: string[]; afterMessageIds: Record<string, string> }) {
    if (!input.chatIds.includes("-1001234567890")) throw new Error("selection was not applied");
    return this.messages.filter((message) => BigInt(message.sourceMessageId)
      >= BigInt(input.afterMessageIds[message.sourceChatId] ?? "0"));
  }
  async getMessage(input: { chatId: string; messageId: string }) {
    return this.messages.find((message) => message.sourceChatId === input.chatId
      && message.sourceMessageId === input.messageId);
  }
}

test("Telegram normalization is deterministic and excludes raw text and provider identifiers", () => {
  const normalized = normalizeTelegramMessage(sourceMessage());
  expect(normalized.contentHash).toStartWith("sha256:");
  expect(normalized.textHash).toStartWith("sha256:");
  expect(JSON.stringify(normalized)).not.toContain("Central Park");
  expect(normalized.chatId).not.toContain("1001234567890");
  expect(normalized.senderHash).not.toContain("998877");
});

test("TDLib adapter uses fixed history and message requests for only selected chats", async () => {
  const requests: Record<string, unknown>[] = [];
  const client: TdLibJsonClient = {
    authorizationState: async () => "authorizationStateReady",
    request: async <T extends Record<string, unknown>>(request: Record<string, unknown>) => {
      requests.push(request);
      if (request["@type"] === "getChatHistory") return { messages: [{
        id: 1048576, chat_id: -1001234567890, date: 1_750_000_000,
        is_outgoing: false, sender_id: { "@type": "messageSenderUser", user_id: 998877 },
        content: { "@type": "messageText", text: { text: "transient" } },
      }] } as unknown as T;
      throw new Error("unexpected request");
    },
  };
  const adapter = new TdLibTelegramAdapter(client);
  expect(await adapter.checkReady()).toEqual({ ok: true, authorizationState: "authorizationStateReady" });
  const messages = await adapter.listMessageChanges({ chatIds: ["-1001234567890"],
    afterMessageIds: { "-1001234567890": "0" }, limitPerChat: 25 });
  expect(messages).toHaveLength(1);
  expect(requests).toEqual([{ "@type": "getChatHistory", chat_id: -1001234567890,
    from_message_id: 0, offset: 0, limit: 25, only_local: false }]);
  await expect(adapter.listMessageChanges({ chatIds: [], afterMessageIds: {}, limitPerChat: 25 }))
    .rejects.toThrow("allowlist");
});

test("TDLib adapter returns every collected delta when changes exceed the page size", async () => {
  const pages = [
    [30, 29, 28], [28, 27, 26], [26, 25, 24], [24, 23, 20],
  ];
  let page = 0;
  const client: TdLibJsonClient = {
    authorizationState: async () => "authorizationStateReady",
    request: async <T extends Record<string, unknown>>() => ({ messages: (pages[page++] ?? []).map((id) => ({
      id, chat_id: -1001234567890, date: 1_750_000_000 + id, is_outgoing: false,
      content: { "@type": "messageText", text: { text: `message ${id}` } },
    })) }) as unknown as T,
  };
  const messages = await new TdLibTelegramAdapter(client).listMessageChanges({
    chatIds: ["-1001234567890"], afterMessageIds: { "-1001234567890": "20" }, limitPerChat: 3,
  });
  expect(messages.map((message) => Number(message.sourceMessageId))).toEqual([23, 24, 25, 26, 27, 28, 29, 30]);
});

test("allowlisted ingestion stores metadata and immutable hashes without Telegram text", async () => {
  const { path, store } = database();
  const adapter = new FakeAdapter([sourceMessage()]);
  const input = { adapter, store, sourceId: "primary", chatIds: ["-1001234567890"], limitPerChat: 25 };
  const first = await ingestTelegramChanges(input);
  const second = await ingestTelegramChanges(input);
  expect(first).toMatchObject({ discovered: 1, ingested: 1, unchanged: 0, modelCalls: 0 });
  expect(second).toMatchObject({ ingested: 0, unchanged: 1, modelCalls: 0 });
  expect(store.countRows("source_events")).toBe(1);
  const db = store.open();
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) count FROM telegram_message_versions").get()?.count).toBe(1);
  expect(Object.keys(db.query("SELECT * FROM telegram_messages").get() as object)).not.toContain("text");
  db.close();
  expect(readFileSync(path)).not.toContain("Central Park");
  expect(new TelegramStore(store).status("primary")).toMatchObject({
    configured: true, chats: 1, messages: 1, versions: 1, ingestionRuns: 2,
    extractionSupported: false,
  });
  expect(new TelegramStore(store).status("primary")).not.toHaveProperty("unextracted");
});

test("edited Telegram source creates a new immutable version", async () => {
  const { store } = database();
  const adapter = new FakeAdapter([sourceMessage("original")]);
  const input = { adapter, store, sourceId: "primary", chatIds: ["-1001234567890"], limitPerChat: 25 };
  await ingestTelegramChanges(input);
  adapter.messages = [{ ...sourceMessage("corrected"), editedAtUnix: 1_750_000_100 }];
  expect(await ingestTelegramChanges(input)).toMatchObject({ ingested: 1 });
  expect(new TelegramStore(store).status("primary").versions).toBe(2);
  expect(store.countRows("source_events")).toBe(2);
});

test("ingestion fails closed and records terminal failures", async () => {
  const { store } = database();
  await expect(ingestTelegramChanges({ adapter: new FakeAdapter([], false), store,
    sourceId: "primary", chatIds: ["-1001234567890"], limitPerChat: 25 })).rejects.toThrow("not ready");
  await expect(ingestTelegramChanges({ adapter: new FakeAdapter([]), store,
    sourceId: "primary", chatIds: [], limitPerChat: 25 })).rejects.toThrow("allowlist");
  const failing = new FakeAdapter([]);
  failing.listMessageChanges = async () => { throw new Error("provider unavailable"); };
  await expect(ingestTelegramChanges({ adapter: failing, store, sourceId: "primary",
    chatIds: ["-1001234567890"], limitPerChat: 25 })).rejects.toThrow("provider unavailable");
  expect(new TelegramStore(store).status("primary").lastRunStatus).toBe("failed");
});
