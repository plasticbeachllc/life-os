import type { TelegramSourceAdapter } from "../adapters/telegram";
import type { OperationalStore } from "../db/store";
import { runIngestion } from "../integrations/ingestion-run";
import { normalizeTelegramMessage } from "../telegram/normalizer";
import { TelegramStore } from "../telegram/store";
import { sha256Text } from "../util/hashing";
import { newId } from "../util/ids";

export interface TelegramIngestionReport {
  runId: string; sourceId: string; configuredChats: number; discovered: number;
  ingested: number; unchanged: number; unavailableText: number; modelCalls: 0;
}

export async function ingestTelegramChanges(input: { adapter: TelegramSourceAdapter;
  store: OperationalStore; sourceId: string; chatIds: string[]; limitPerChat: number }): Promise<TelegramIngestionReport> {
  if (input.chatIds.length === 0) throw new Error("Telegram ingestion requires an explicit chat allowlist");
  input.store.migrate();
  const ready = await input.adapter.checkReady();
  if (!ready.ok) throw new Error(`TDLib is not ready: ${ready.authorizationState}`);
  const telegramStore = new TelegramStore(input.store);
  const startedAt = new Date().toISOString();
  telegramStore.ensureSource({ sourceId: input.sourceId, now: startedAt });
  const runId = newId("run");
  const report: TelegramIngestionReport = { runId, sourceId: input.sourceId,
    configuredChats: input.chatIds.length, discovered: 0, ingested: 0,
    unchanged: 0, unavailableText: 0, modelCalls: 0 };
  return runIngestion({
    start: () => telegramStore.startRun({ runId, sourceId: input.sourceId, startedAt }),
    execute: async () => {
      const hashes = Object.fromEntries(input.chatIds.map((id) => [id, sha256Text(id)]));
      const stored = telegramStore.cursors(input.sourceId, Object.values(hashes));
      const afterMessageIds = Object.fromEntries(input.chatIds.map((id) => [id, stored[hashes[id]!] ?? "0"]));
      const sourceMessages = await input.adapter.listMessageChanges({
        chatIds: input.chatIds, afterMessageIds, limitPerChat: input.limitPerChat,
      });
      report.discovered = sourceMessages.length;
      Object.assign(report, telegramStore.saveBatch({ sourceId: input.sourceId,
        messages: sourceMessages.map(normalizeTelegramMessage), now: new Date().toISOString() }));
      return report;
    },
    complete: (result) => telegramStore.finishRun({ runId, completedAt: new Date().toISOString(),
      status: "completed", discovered: result.discovered, ingested: result.ingested,
      unchanged: result.unchanged, unavailableText: result.unavailableText }),
    fail: (error) => telegramStore.finishRun({ runId, completedAt: new Date().toISOString(),
      status: "failed", discovered: report.discovered, ingested: report.ingested,
      unchanged: report.unchanged, unavailableText: report.unavailableText,
      error: error instanceof Error ? error.message : String(error) }),
  });
}
