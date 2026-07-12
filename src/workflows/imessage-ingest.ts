import type { IMessageConversationSelection, IMessageSourceAdapter } from "../adapters/imessage";
import type { OperationalStore } from "../db/store";
import { IMessageStore } from "../imessage/store";
import { normalizeIMessage } from "../imessage/normalizer";
import { newId } from "../util/ids";

export interface IMessageIngestionReport {
  runId: string;
  sourceId: string;
  selectionMode: IMessageConversationSelection["mode"];
  configuredConversationIds: number;
  cursorBefore: number;
  cursorAfter: number;
  discovered: number;
  ingested: number;
  unchanged: number;
  unavailableText: number;
  modelCalls: 0;
}

export async function ingestIMessageChanges(input: {
  adapter: IMessageSourceAdapter; store: OperationalStore; sourceId: string;
  selection: IMessageConversationSelection; limit: number;
}): Promise<IMessageIngestionReport> {
  if (input.selection.mode === "allowlist" && input.selection.conversationIds.length === 0) {
    throw new Error("iMessage allowlist mode requires at least one conversation");
  }
  input.store.migrate();
  const access = await input.adapter.checkAccess();
  if (!access.ok) throw new Error(access.reason ?? "Messages database is unavailable");
  const imessageStore = new IMessageStore(input.store);
  const startedAt = new Date().toISOString();
  imessageStore.ensureSource({ sourceId: input.sourceId, now: startedAt });
  const cursorBefore = imessageStore.cursor(input.sourceId);
  const runId = newId("run");
  imessageStore.startRun({ runId, sourceId: input.sourceId, startedAt });
  const report: IMessageIngestionReport = {
    runId, sourceId: input.sourceId, selectionMode: input.selection.mode,
    configuredConversationIds: input.selection.conversationIds.length,
    cursorBefore, cursorAfter: cursorBefore, discovered: 0, ingested: 0,
    unchanged: 0, unavailableText: 0, modelCalls: 0,
  };
  try {
    const sourceMessages = await input.adapter.listMessageChanges({
      // Recheck a bounded tail because Messages can edit an existing row in place.
      afterRowId: Math.max(0, cursorBefore - 500),
      selection: input.selection, limit: input.limit,
    });
    report.discovered = sourceMessages.length;
    const messages = sourceMessages.map(normalizeIMessage);
    report.cursorAfter = Math.max(cursorBefore, ...messages.map((message) => message.sourceRowId));
    const saved = imessageStore.saveBatch({
      sourceId: input.sourceId, messages, now: new Date().toISOString(), nextCursor: report.cursorAfter,
    });
    Object.assign(report, saved);
    imessageStore.finishRun({
      runId, completedAt: new Date().toISOString(), status: "completed",
      discovered: report.discovered, ingested: report.ingested,
      unchanged: report.unchanged, unavailableText: report.unavailableText,
    });
    return report;
  } catch (error) {
    imessageStore.finishRun({
      runId, completedAt: new Date().toISOString(), status: "failed",
      discovered: report.discovered, ingested: report.ingested,
      unchanged: report.unchanged, unavailableText: report.unavailableText,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
