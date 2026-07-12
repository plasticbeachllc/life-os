import type { GmailApiThread, GmailSourceAdapter } from "../adapters/gmail";
import type { OperationalStore } from "../db/store";
import { GmailStore } from "../gmail/store";
import { gmailThreadStateHash } from "../gmail/store";
import { normalizeGmailMessage, type NormalizedGmailMessage } from "../gmail/normalizer";
import { newId } from "../util/ids";
import { runIngestion } from "../integrations/ingestion-run";

export interface GmailIngestionReport {
  runId: string;
  accountId: string;
  selector: "IMPORTANT";
  discovered: number;
  ingested: number;
  unchanged: number;
  failed: number;
  failures: Array<{ messageId: string; error: string }>;
  modelCalls: 0;
}

export async function ingestImportantGmail(input: {
  adapter: GmailSourceAdapter; store: OperationalStore; accountId: string; limit: number;
}): Promise<GmailIngestionReport> {
  input.store.migrate();
  const gmailStore = new GmailStore(input.store);
  const profile = await input.adapter.getProfile();
  const startedAt = new Date().toISOString();
  const runId = newId("run");
  gmailStore.upsertAccount({
    accountId: input.accountId, emailAddress: profile.emailAddress,
    selectionLabelId: "IMPORTANT", ...(profile.historyId ? { historyId: profile.historyId } : {}),
    now: startedAt,
  });
  const report: GmailIngestionReport = {
    runId, accountId: input.accountId, selector: "IMPORTANT",
    discovered: 0, ingested: 0, unchanged: 0, failed: 0, failures: [], modelCalls: 0,
  };
  return runIngestion({
    start: () => gmailStore.startRun({ runId, accountId: input.accountId, startedAt }),
    execute: async () => {
      const messageIds = await listMessageIds(input.adapter, input.limit);
      report.discovered = messageIds.length;
      const threadCache = new Map<string, { thread: GmailApiThread; normalized: NormalizedGmailMessage[] }>();
      for (const messageId of messageIds) {
        try {
          const message = await input.adapter.getMessage(messageId);
          if (!(message.labelIds ?? []).includes("IMPORTANT")) throw new Error("selected message no longer has IMPORTANT label");
          const normalized = normalizeGmailMessage(message);
          let threadContext = threadCache.get(message.threadId);
          if (!threadContext) {
            const thread = await input.adapter.getThread(message.threadId);
            threadContext = { thread, normalized: (thread.messages ?? []).map(normalizeGmailMessage) };
            threadCache.set(message.threadId, threadContext);
          }
          const messageUnchanged = gmailStore.currentMessageHash(input.accountId, messageId) === normalized.contentHash;
          const threadUnchanged = gmailStore.currentThreadHash(input.accountId, message.threadId)
            === gmailThreadStateHash(threadContext.normalized);
          if (messageUnchanged && threadUnchanged) {
            report.unchanged += 1;
            continue;
          }
          gmailStore.saveMessageAndThread({ accountId: input.accountId, message: normalized,
            threadMessages: threadContext.normalized, now: new Date().toISOString() });
          report.ingested += 1;
        } catch (error) {
          report.failed += 1;
          report.failures.push({ messageId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return report;
    },
    complete: (result) => gmailStore.finishRun({
      runId, completedAt: new Date().toISOString(), status: "completed",
      discovered: result.discovered, ingested: result.ingested,
      unchanged: result.unchanged, failed: result.failed,
    }),
    fail: (error) => gmailStore.finishRun({
      runId, completedAt: new Date().toISOString(), status: "failed",
      discovered: report.discovered, ingested: report.ingested,
      unchanged: report.unchanged, failed: report.failed,
      error: error instanceof Error ? error.message : String(error),
    }),
  });
}

async function listMessageIds(adapter: GmailSourceAdapter, limit: number): Promise<string[]> {
  const result: string[] = [];
  let pageToken: string | undefined;
  while (result.length < limit) {
    const page = await adapter.listImportantMessageIds({
      maxResults: Math.min(500, limit - result.length), ...(pageToken ? { pageToken } : {}),
    });
    result.push(...page.messageIds.slice(0, limit - result.length));
    pageToken = page.nextPageToken;
    if (!pageToken || page.messageIds.length === 0) break;
  }
  return [...new Set(result)];
}
