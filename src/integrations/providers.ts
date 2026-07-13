import { GoogleCalendarRestAdapter } from "../adapters/calendar";
import { GmailRestAdapter } from "../adapters/gmail";
import { MacOsMessagesAdapter } from "../adapters/imessage";
import { TdLibTelegramAdapter } from "../adapters/telegram";
import { CalendarStore } from "../calendar/store";
import { loadConfig, loadGmailAuthConfig, loadTelegramTdLibConfig } from "../config";
import { OperationalStore } from "../db/store";
import { currentEmailExtractionIdentity } from "../gmail/extraction-contract";
import { MacOsKeychainGmailCredentialStore } from "../gmail/keychain";
import { GmailStore } from "../gmail/store";
import { IMessageStore } from "../imessage/store";
import { TelegramStore } from "../telegram/store";
import { NativeTdJsonClient } from "../telegram/tdjson-client";
import { ingestCalendar } from "../workflows/calendar-ingest";
import { ingestImportantGmail } from "../workflows/gmail-ingest";
import type { GmailIngestionReport } from "../workflows/gmail-ingest";
import { ingestIMessageChanges } from "../workflows/imessage-ingest";
import { ingestTelegramChanges } from "../workflows/telegram-ingest";
import type { IntegrationCapabilities, IntegrationCounts } from "./contract";
import { IntegrationRegistry } from "./registry";

const messageExtractionCapabilities: IntegrationCapabilities = Object.freeze({
  ingestion: true, immutableVersions: true, transientRefetch: true,
  extraction: true, providerMutation: false,
});

const ingestionOnlyCapabilities: IntegrationCapabilities = Object.freeze({
  ingestion: true, immutableVersions: true, transientRefetch: false,
  extraction: false, providerMutation: false,
});

export function createIntegrationRegistry(): IntegrationRegistry {
  return new IntegrationRegistry()
    .register({
      id: "gmail", capabilities: messageExtractionCapabilities,
      application: { cliCommand: "email", statusTool: "life_os_gmail_status", ingestTool: "life_os_ingest_gmail" },
      statusDescription: "Return sanitized Gmail integration status and capabilities.",
      ingestDescription: "Incrementally ingest metadata and hashes for IMPORTANT Gmail messages using gmail.readonly. Never sends, labels, archives, or deletes email.",
      limit: { default: 50, maximum: 100, description: "Maximum IMPORTANT messages to inspect." },
      status: () => {
        const config = loadConfig(); const store = operationalStore(config.databasePath);
        return status("gmail", "primary", config.gmailEnabled, messageExtractionCapabilities,
          new GmailStore(store).inspectionSummary(config.gmailAccountId, currentEmailExtractionIdentity));
      },
      ingest: async ({ limit }) => {
        const config = loadConfig();
        if (!config.gmailEnabled) throw new Error("Gmail ingestion is disabled");
        const report = await ingestImportantGmail({ adapter: gmailAdapter(config.gmailAccountId),
          store: operationalStore(config.databasePath), accountId: config.gmailAccountId, limit: limit ?? 50 });
        return result("gmail", "primary", report.runId,
          counts(report.discovered, report.ingested, report.unchanged, report.failed, 0),
          gmailIngestionDetails(report));
      },
    })
    .register({
      id: "imessage", capabilities: messageExtractionCapabilities,
      application: { cliCommand: "message", statusTool: "life_os_imessage_status", ingestTool: "life_os_ingest_imessage" },
      statusDescription: "Return sanitized Messages integration status and capabilities.",
      ingestDescription: "Incrementally ingest metadata and hashes from the configured Messages selection. Never sends or modifies messages.",
      limit: { default: 500, maximum: 5000, description: "Maximum Messages rows to inspect." },
      status: async () => {
        const config = loadConfig(); const store = operationalStore(config.databasePath);
        const access = await new MacOsMessagesAdapter(config.imessageDatabasePath).checkAccess();
        const { cursor: _cursor, ...summary } = new IMessageStore(store)
          .inspectionSummary(config.imessageSourceId);
        return status("imessage", "primary", config.imessageEnabled,
          messageExtractionCapabilities, {
            selectionMode: config.imessageSelectionMode,
            configuredConversationIds: config.imessageConversationIds.length,
            access,
            ...summary,
          });
      },
      ingest: async ({ limit }) => {
        const config = loadConfig();
        if (!config.imessageEnabled) throw new Error("Messages ingestion is disabled");
        const report = await ingestIMessageChanges({ adapter: new MacOsMessagesAdapter(config.imessageDatabasePath),
          store: operationalStore(config.databasePath), sourceId: config.imessageSourceId,
          selection: { mode: config.imessageSelectionMode, conversationIds: config.imessageConversationIds },
          limit: limit ?? 500 });
        return result("imessage", "primary", report.runId,
          counts(report.discovered, report.ingested, report.unchanged, 0, report.unavailableText), {
            selectionMode: report.selectionMode,
            configuredConversationIds: report.configuredConversationIds,
            cursorAdvanced: report.cursorAfter > report.cursorBefore,
          });
      },
    })
    .register({
      id: "calendar", capabilities: ingestionOnlyCapabilities,
      application: { cliCommand: "calendar", statusTool: "life_os_calendar_status", ingestTool: "life_os_ingest_calendar" },
      statusDescription: "Return sanitized Google Calendar integration status and capabilities.",
      ingestDescription: "Incrementally ingest the primary Google Calendar using calendar.readonly. Never writes Google Calendar.",
      status: () => {
        const config = loadConfig(); const store = operationalStore(config.databasePath);
        return status("calendar", "primary", config.calendarEnabled,
          ingestionOnlyCapabilities, new CalendarStore(store).summary(config.gmailAccountId));
      },
      ingest: async () => {
        const config = loadConfig();
        if (!config.calendarEnabled) throw new Error("Calendar ingestion is disabled");
        const report = await ingestCalendar({ adapter: new GoogleCalendarRestAdapter(
          loadGmailAuthConfig(refreshToken(config.gmailAccountId))),
        store: operationalStore(config.databasePath), accountId: config.gmailAccountId });
        return result("calendar", "primary", report.runId,
          counts(report.discovered, report.changed, report.unchanged, 0, 0),
          { stateId: report.stateId });
      },
    })
    .register({
      id: "telegram", capabilities: ingestionOnlyCapabilities,
      application: { cliCommand: "telegram", statusTool: "life_os_telegram_status", ingestTool: "life_os_ingest_telegram" },
      statusDescription: "Return sanitized Telegram integration status and capabilities.",
      ingestDescription: "Incrementally ingest metadata and hashes from explicitly allowlisted Telegram chats. Never sends or modifies messages.",
      limit: { default: 50, maximum: 100, description: "Bounded TDLib history page size per chat." },
      status: () => {
        const config = loadConfig(); const store = operationalStore(config.databasePath);
        return status("telegram", "primary", config.telegramEnabled,
          ingestionOnlyCapabilities, new TelegramStore(store).status(config.telegramSourceId));
      },
      ingest: async ({ limit }) => {
        const config = loadConfig();
        if (!config.telegramEnabled) throw new Error("Telegram ingestion is disabled");
        if (config.telegramChatIds.length === 0) throw new Error("Telegram ingestion requires a configured chat allowlist");
        const client = new NativeTdJsonClient({ ...loadTelegramTdLibConfig(),
          databaseDirectory: config.telegramDatabaseDirectory });
        try {
          const report = await ingestTelegramChanges({ adapter: new TdLibTelegramAdapter(client),
            store: operationalStore(config.databasePath), sourceId: config.telegramSourceId,
            chatIds: config.telegramChatIds, limitPerChat: limit ?? 50 });
          return result("telegram", "primary", report.runId,
            counts(report.discovered, report.ingested, report.unchanged, 0, report.unavailableText),
            { configuredChats: report.configuredChats });
        } finally { client.close(); }
      },
    });
}

function operationalStore(path: string): OperationalStore {
  const store = new OperationalStore(path); store.migrate(); return store;
}

function refreshToken(accountId: string): string {
  const token = Bun.env.GMAIL_REFRESH_TOKEN
    ?? new MacOsKeychainGmailCredentialStore().getRefreshToken(accountId);
  if (!token) throw new Error("Google refresh token unavailable; reauthorize first");
  return token;
}

function gmailAdapter(accountId: string): GmailRestAdapter {
  return new GmailRestAdapter(loadGmailAuthConfig(refreshToken(accountId)));
}

function counts(discovered: number, changed: number, unchanged: number,
  failed: number, unavailableContent: number): IntegrationCounts {
  return { discovered, changed, unchanged, failed, unavailableContent };
}

export function gmailIngestionDetails(report: Pick<GmailIngestionReport, "selector" | "failures">): {
  selector: "IMPORTANT"; partialFailures: number; failureCategories: Record<string, number>;
} {
  const failureCategories: Record<string, number> = {};
  for (const failure of report.failures) {
    const category = /no longer has IMPORTANT label/.test(failure.error)
      ? "selection_changed"
      : /API request failed|OAuth|access token/i.test(failure.error)
        ? "provider_request_failed"
        : "processing_failed";
    failureCategories[category] = (failureCategories[category] ?? 0) + 1;
  }
  return { selector: report.selector, partialFailures: report.failures.length, failureCategories };
}

function status(provider: string, sourceId: string,
  enabled: boolean, capabilities: IntegrationCapabilities, details: unknown) {
  return { provider, sourceId, enabled, capabilities, details };
}

function result(provider: string, sourceId: string,
  runId: string, integrationCounts: IntegrationCounts, details: unknown) {
  return { provider, sourceId, runId, counts: integrationCounts, modelCalls: 0 as const, details };
}
