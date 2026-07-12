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
      statusDescription: "Return sanitized Gmail integration status and capabilities.",
      ingestDescription: "Incrementally ingest metadata and hashes for IMPORTANT Gmail messages using gmail.readonly. Never sends, labels, archives, or deletes email.",
      limit: { default: 50, maximum: 5000, description: "Maximum IMPORTANT messages to inspect." },
      status: () => {
        const config = loadConfig(); const store = operationalStore(config.databasePath);
        return status("gmail", config.gmailAccountId, config.gmailEnabled, messageExtractionCapabilities,
          new GmailStore(store).inspectionSummary(config.gmailAccountId, currentEmailExtractionIdentity));
      },
      ingest: async ({ limit }) => {
        const config = loadConfig();
        if (!config.gmailEnabled) throw new Error("Gmail ingestion is disabled");
        const report = await ingestImportantGmail({ adapter: gmailAdapter(config.gmailAccountId),
          store: operationalStore(config.databasePath), accountId: config.gmailAccountId, limit: limit ?? 50 });
        return result("gmail", config.gmailAccountId, report.runId,
          counts(report.discovered, report.ingested, report.unchanged, report.failed, 0), report);
      },
    })
    .register({
      id: "imessage", capabilities: messageExtractionCapabilities,
      statusDescription: "Return sanitized Messages integration status and capabilities.",
      ingestDescription: "Incrementally ingest metadata and hashes from the configured Messages selection. Never sends or modifies messages.",
      limit: { default: 500, maximum: 5000, description: "Maximum Messages rows to inspect." },
      status: () => {
        const config = loadConfig(); const store = operationalStore(config.databasePath);
        return status("imessage", config.imessageSourceId, config.imessageEnabled,
          messageExtractionCapabilities, {
            selectionMode: config.imessageSelectionMode,
            configuredConversationIds: config.imessageConversationIds.length,
            ...new IMessageStore(store).inspectionSummary(config.imessageSourceId),
          });
      },
      ingest: async ({ limit }) => {
        const config = loadConfig();
        if (!config.imessageEnabled) throw new Error("Messages ingestion is disabled");
        const report = await ingestIMessageChanges({ adapter: new MacOsMessagesAdapter(config.imessageDatabasePath),
          store: operationalStore(config.databasePath), sourceId: config.imessageSourceId,
          selection: { mode: config.imessageSelectionMode, conversationIds: config.imessageConversationIds },
          limit: limit ?? 500 });
        return result("imessage", config.imessageSourceId, report.runId,
          counts(report.discovered, report.ingested, report.unchanged, 0, report.unavailableText), report);
      },
    })
    .register({
      id: "calendar", capabilities: ingestionOnlyCapabilities,
      statusDescription: "Return sanitized Google Calendar integration status and capabilities.",
      ingestDescription: "Incrementally ingest the primary Google Calendar using calendar.readonly. Never writes Google Calendar.",
      status: () => {
        const config = loadConfig(); const store = operationalStore(config.databasePath);
        return status("calendar", config.gmailAccountId, config.calendarEnabled,
          ingestionOnlyCapabilities, new CalendarStore(store).summary(config.gmailAccountId));
      },
      ingest: async () => {
        const config = loadConfig();
        if (!config.calendarEnabled) throw new Error("Calendar ingestion is disabled");
        const report = await ingestCalendar({ adapter: new GoogleCalendarRestAdapter(
          loadGmailAuthConfig(refreshToken(config.gmailAccountId))),
        store: operationalStore(config.databasePath), accountId: config.gmailAccountId });
        return result("calendar", config.gmailAccountId, report.runId,
          counts(report.discovered, report.changed, report.unchanged, 0, 0), report);
      },
    })
    .register({
      id: "telegram", capabilities: ingestionOnlyCapabilities,
      statusDescription: "Return sanitized Telegram integration status and capabilities.",
      ingestDescription: "Incrementally ingest metadata and hashes from explicitly allowlisted Telegram chats. Never sends or modifies messages.",
      limit: { default: 50, maximum: 100, description: "Bounded TDLib history page size per chat." },
      status: () => {
        const config = loadConfig(); const store = operationalStore(config.databasePath);
        return status("telegram", config.telegramSourceId, config.telegramEnabled,
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
          return result("telegram", config.telegramSourceId, report.runId,
            counts(report.discovered, report.ingested, report.unchanged, 0, report.unavailableText), report);
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

function status(provider: string, sourceId: string,
  enabled: boolean, capabilities: IntegrationCapabilities, details: unknown) {
  return { provider, sourceId, enabled, capabilities, details };
}

function result(provider: string, sourceId: string,
  runId: string, integrationCounts: IntegrationCounts, details: unknown) {
  return { provider, sourceId, runId, counts: integrationCounts, modelCalls: 0 as const, details };
}
