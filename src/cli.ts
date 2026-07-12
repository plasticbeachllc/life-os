#!/usr/bin/env bun

import { ObsidianVault } from "./adapters/obsidian";
import { GmailRestAdapter } from "./adapters/gmail";
import { MacOsMessagesAdapter } from "./adapters/imessage";
import { GoogleCalendarRestAdapter } from "./adapters/calendar";
import { loadConfig, loadGmailAuthConfig, loadGmailClientConfig } from "./config";
import { OperationalStore } from "./db/store";
import type { ProposalRecord } from "./db/store";
import type { Finding, HealthReport, Severity } from "./models/common";
import { applyApprovedProposal } from "./tools/apply-frontmatter-patch";
import { applyPolicyBootstrapProposal } from "./tools/bootstrap-policy-file";
import { applyTaskIdProposal } from "./tools/apply-task-id-patch";
import { undoAction } from "./tools/undo-action";
import { proposePolicyBootstrap } from "./workflows/bootstrap-policy";
import { applyPolicyBootstrapSet, pendingPolicyBootstrapSet } from "./workflows/apply-policy-bootstrap-set";
import { runDoctor } from "./workflows/doctor";
import { proposeMetadataNormalization } from "./workflows/normalize-metadata";
import { proposeTaskIdNormalization } from "./workflows/normalize-task-ids";
import { formatMorningBriefing, generateMorningBriefing, type MorningBriefing } from "./workflows/morning-briefing";
import { efficiencyReport } from "./workflows/efficiency-metrics";
import { rebuildState, type StateRebuildReport } from "./workflows/rebuild-state";
import { ingestImportantGmail } from "./workflows/gmail-ingest";
import { MacOsKeychainGmailCredentialStore } from "./gmail/keychain";
import { authorizeGmailDesktop } from "./workflows/gmail-auth";
import { GmailStore } from "./gmail/store";
import { currentEmailExtractionIdentity } from "./gmail/extraction-contract";
import { previewGmailExtractionContext } from "./workflows/gmail-extraction-preview";
import { IMessageStore } from "./imessage/store";
import { ingestIMessageChanges } from "./workflows/imessage-ingest";
import { previewIMessageExtractionContext } from "./workflows/imessage-extraction-preview";
import { triageIMessageServiceConversations } from "./workflows/imessage-deterministic-triage";
import { linkIMessageConversationToPerson } from "./workflows/link-imessage-person";
import { ingestCalendar } from "./workflows/calendar-ingest";
import { CalendarStore } from "./calendar/store";
import { TdLibTelegramAdapter } from "./adapters/telegram";
import { loadTelegramTdLibConfig } from "./config";
import { NativeTdJsonClient } from "./telegram/tdjson-client";
import { TelegramStore } from "./telegram/store";
import { ingestTelegramChanges } from "./workflows/telegram-ingest";
import { FindingStore } from "./findings/store";
import { rebuildFindingAttentionState } from "./state/finding-attention";
import { rebuildChiefOfStaffState } from "./state/chief-of-staff";
import { applyFindingTaskProposal } from "./tools/append-finding-task";

const symbols: Record<Severity, string> = {
  ok: "OK",
  info: "INFO",
  warning: "WARN",
  error: "ERR",
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "doctor") {
    const args = parseFlags(rest);
    const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
    const report = await runDoctor({
      vault: new ObsidianVault(config.vaultPath),
      store: new OperationalStore(config.databasePath),
    });
    if (args.flags.json === "true") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReport(report, config.vaultPath));
    }
    return report.errorCount > 0 ? 1 : 0;
  }

  if (command === "db") {
    const [subcommand, ...dbRest] = rest;
    if (subcommand === "migrate") {
      const args = parseFlags(dbRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const store = new OperationalStore(config.databasePath);
      store.migrate();
      console.log(`Migrated operational database: ${config.databasePath}`);
      return 0;
    }
  }

  if (command === "state") {
    const [subcommand, ...stateRest] = rest;
    if (subcommand === "rebuild") {
      const args = parseFlags(stateRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const report = await rebuildState({
        vault: new ObsidianVault(config.vaultPath),
        store: new OperationalStore(config.databasePath),
      });
      console.log(args.flags.json === "true" ? JSON.stringify(report, null, 2) : formatStateReport(report));
      return report.issues.length > 0 ? 1 : 0;
    }
    if (subcommand === "show") {
      const args = parseFlags(stateRest);
      const requestedType = args.positionals[0];
      const stateTypes: Record<string, string> = {
        projects: "project_state", people: "person_state", tasks: "task_state",
        "chief-of-staff": "chief_of_staff_state",
      };
      if (!requestedType || !stateTypes[requestedType]) {
        throw new Error("state show requires projects, people, tasks, or chief-of-staff");
      }
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const store = new OperationalStore(config.databasePath);
      store.migrate();
      const records = store.listCurrentDerivedStates(stateTypes[requestedType]);
      console.log(JSON.stringify(records.map((record) => ({
        stateId: record.stateId, entityId: record.entityId ?? null,
        stateVersion: record.stateVersion, content: record.content,
        sourceHashes: record.sourceHashes, generationMethod: record.generationMethod,
      })), null, 2));
      return 0;
    }
  }

  if (command === "normalize") {
    const [subcommand, ...normalizeRest] = rest;
    if (subcommand === "propose") {
      const args = parseFlags(normalizeRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const report = await proposeMetadataNormalization({
        vault: new ObsidianVault(config.vaultPath),
        store: new OperationalStore(config.databasePath),
      });
      if (args.flags.json === "true") console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`Normalization proposals\nCreated: ${report.created.length}\nExisting: ${report.existing.length}`);
        for (const proposal of [...report.created, ...report.existing]) console.log(formatProposal(proposal));
        for (const issue of report.issues) console.log(`ERR - ${issue.path} - ${issue.message}`);
      }
      return report.issues.length > 0 ? 1 : 0;
    }
    if (subcommand === "tasks") {
      const args = parseFlags(normalizeRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const report = await proposeTaskIdNormalization({
        vault: new ObsidianVault(config.vaultPath), store: new OperationalStore(config.databasePath),
      });
      if (args.flags.json === "true") console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`Task ID normalization proposals\nCreated: ${report.created.length}\nExisting: ${report.existing.length}`);
        for (const proposal of [...report.created, ...report.existing]) console.log(formatProposal(proposal));
      }
      return 0;
    }
  }

  if (command === "policy") {
    const [subcommand, ...policyRest] = rest;
    if (subcommand === "bootstrap") {
      const args = parseFlags(policyRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const report = await proposePolicyBootstrap({
        vault: new ObsidianVault(config.vaultPath), store: new OperationalStore(config.databasePath),
      });
      if (args.flags.json === "true") console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`Policy bootstrap proposals\nCreated: ${report.created.length}\nExisting: ${report.existing.length}\nAlready present: ${report.skipped.length}`);
        for (const proposal of [...report.created, ...report.existing]) console.log(formatProposal(proposal));
        const set = pendingPolicyBootstrapSet(new OperationalStore(config.databasePath));
        if (set.proposals.length > 0) {
          console.log(`\nExact-set confirmation token: ${set.confirmationToken}`);
          console.log(`Batch apply: life-os policy apply-bootstrap --confirm ${set.confirmationToken} --vault <path>`);
        }
      }
      return 0;
    }
    if (subcommand === "apply-bootstrap") {
      const args = parseFlags(policyRest);
      const confirmationToken = args.flags.confirm;
      if (!confirmationToken || confirmationToken === "true") throw new Error("policy apply-bootstrap requires --confirm <exact-set-token>");
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const store = new OperationalStore(config.databasePath);
      store.migrate();
      const result = await applyPolicyBootstrapSet({
        confirmationToken, vault: new ObsidianVault(config.vaultPath),
        store, backupRoot: config.backupPath,
      });
      console.log(`Applied ${result.applied.length} policy bootstrap actions.`);
      for (const item of result.applied) console.log(`OK - ${item.targetPath} - ${item.actionId}`);
      return 0;
    }
  }

  if (command === "review") {
    const args = parseFlags(rest);
    const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
    const store = new OperationalStore(config.databasePath);
    store.migrate();
    const proposal = args.positionals[0];
    const proposals = proposal ? [store.getProposal(proposal)].filter((item): item is ProposalRecord => Boolean(item)) : store.listPendingProposals();
    if (proposal && proposals.length === 0) throw new Error(`proposal not found: ${proposal}`);
    console.log(proposals.length === 0 ? "No pending proposals." : proposals.map(formatProposal).join("\n"));
    return 0;
  }

  if (command === "findings") {
    const [subcommand, ...findingRest] = rest;
    const args = parseFlags(findingRest);
    const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
    const store = new OperationalStore(config.databasePath);
    store.migrate();
    const findings = new FindingStore(store);
    if (subcommand === "review") {
      console.log(JSON.stringify(findings.review(), null, 2));
      return 0;
    }
    const findingId = args.positionals[0];
    if (!findingId) throw new Error(`findings ${subcommand ?? "command"} requires <finding-id>`);
    if (subcommand === "dismiss") {
      if (!args.flags.reason) throw new Error("findings dismiss requires --reason <text>");
      const eventId = findings.dismiss({ findingId, reason: args.flags.reason });
      const attention = rebuildFindingAttentionState({ store });
      rebuildChiefOfStaffState({ store });
      console.log(JSON.stringify({ findingId, status: "dismissed", eventId,
        attentionStateId: attention.stateId }, null, 2));
      return 0;
    }
    if (subcommand === "supersede") {
      if (!args.flags.replacement || !args.flags.reason) {
        throw new Error("findings supersede requires --replacement <finding-id> --reason <text>");
      }
      const eventId = findings.supersede({
        findingId, replacementFindingId: args.flags.replacement, reason: args.flags.reason,
      });
      const attention = rebuildFindingAttentionState({ store });
      rebuildChiefOfStaffState({ store });
      console.log(JSON.stringify({ findingId, status: "superseded", eventId,
        replacementFindingId: args.flags.replacement, attentionStateId: attention.stateId }, null, 2));
      return 0;
    }
    throw new Error("findings supports review, dismiss, or supersede");
  }

  if (command === "approve") {
    const args = parseFlags(rest);
    const proposalId = args.positionals[0];
    const actionId = args.flags.action;
    if (!proposalId || !actionId) throw new Error("approve requires <proposal-id> --action <action-id>");
    const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
    const store = new OperationalStore(config.databasePath);
    store.migrate();
    store.approveProposalAction(proposalId, actionId, new Date().toISOString());
    console.log(`Approved ${actionId} in ${proposalId}`);
    return 0;
  }

  if (command === "apply") {
    const args = parseFlags(rest);
    const proposalId = args.positionals[0];
    if (!proposalId) throw new Error("apply requires <proposal-id>");
    const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
    const store = new OperationalStore(config.databasePath);
    store.migrate();
    const proposal = store.getProposal(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    const toolInput = { proposalId, vault: new ObsidianVault(config.vaultPath), store, backupRoot: config.backupPath };
    const result = proposal.toolName === "bootstrap_policy_file"
      ? await applyPolicyBootstrapProposal(toolInput)
      : proposal.toolName === "apply_task_id_patch"
        ? await applyTaskIdProposal(toolInput)
        : proposal.toolName === "append_finding_task"
            ? await applyFindingTaskProposal(toolInput)
            : await applyApprovedProposal(toolInput);
    console.log(`Applied ${result.actionId} to ${result.targetPath}\nBackup: ${result.backupPath}`);
    return 0;
  }

  if (command === "undo") {
    const args = parseFlags(rest);
    const actionId = args.positionals[0];
    if (!actionId) throw new Error("undo requires <action-id>");
    const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
    const store = new OperationalStore(config.databasePath);
    store.migrate();
    const result = await undoAction({ actionId, vault: new ObsidianVault(config.vaultPath), store });
    console.log(`Undid ${result.actionId} on ${result.targetPath}`);
    return 0;
  }

  if (command === "briefing") {
    const [subcommand, ...briefingRest] = rest;
    if (subcommand === "morning") {
      const args = parseFlags(briefingRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const store = new OperationalStore(config.databasePath);
      store.migrate();
      const result = generateMorningBriefing({ store });
      const briefing = result.state.content as unknown as MorningBriefing;
      console.log(args.flags.json === "true"
        ? JSON.stringify({ stateId: result.state.stateId, cached: result.cached, ...briefing }, null, 2)
        : `${formatMorningBriefing(briefing, result.cached)}\nState: ${result.state.stateId}`);
      return 0;
    }
    if (subcommand === "feedback") {
      const args = parseFlags(briefingRest);
      const stateId = args.positionals[0];
      const itemKey = args.flags.item;
      const usefulFlag = args.flags.useful;
      if (!stateId || !itemKey || !["true", "false"].includes(String(usefulFlag))) {
        throw new Error("briefing feedback requires <state-id> --item <section:index> --useful <true|false>");
      }
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const store = new OperationalStore(config.databasePath);
      store.migrate();
      const state = store.getDerivedStateById(stateId);
      if (!state || state.stateType !== "daily_state") throw new Error("daily briefing state not found");
      assertBriefingItemExists(state.content, itemKey);
      store.recordBriefingFeedback({
        stateId, itemKey, useful: usefulFlag === "true", recordedAt: new Date().toISOString(),
      });
      console.log(`Recorded ${itemKey} as ${usefulFlag === "true" ? "useful" : "not useful"} for ${stateId}`);
      return 0;
    }
  }

  if (command === "metrics") {
    const [subcommand, ...metricsRest] = rest;
    if (subcommand === "efficiency") {
      const args = parseFlags(metricsRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const store = new OperationalStore(config.databasePath);
      store.migrate();
      console.log(JSON.stringify(efficiencyReport(store), null, 2));
      return 0;
    }
  }

  if (command === "email") {
    const [subcommand, ...emailRest] = rest;
    if (subcommand === "status") {
      const args = parseFlags(emailRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const store = new OperationalStore(config.databasePath);
      store.migrate();
      console.log(JSON.stringify(new GmailStore(store).inspectionSummary(
        config.gmailAccountId, currentEmailExtractionIdentity,
      ), null, 2));
      return 0;
    }
    if (subcommand === "review-extractions") {
      const args = parseFlags(emailRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const store = new OperationalStore(config.databasePath);
      store.migrate();
      console.log(JSON.stringify(new GmailStore(store).extractionReview(
        config.gmailAccountId, currentEmailExtractionIdentity,
      ), null, 2));
      return 0;
    }
    if (subcommand === "auth") {
      const args = parseFlags(emailRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const client = loadGmailClientConfig();
      const result = await authorizeGmailDesktop({
        ...client, accountId: config.gmailAccountId,
        credentialStore: new MacOsKeychainGmailCredentialStore(),
      });
      console.log(`Authorized Google read-only integrations for ${result.emailAddress}. Refresh token stored in ${result.storedIn}.`);
      return 0;
    }
    if (subcommand === "ingest") {
      const args = parseFlags(emailRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      if (!config.gmailEnabled) throw new Error("Gmail ingestion is disabled; set LIFE_OS_GMAIL_ENABLED=true");
      const limit = Number(args.flags.limit ?? "50");
      if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
        throw new Error("--limit must be an integer between 1 and 5000");
      }
      const credentialStore = new MacOsKeychainGmailCredentialStore();
      const refreshToken = Bun.env.GMAIL_REFRESH_TOKEN
        ?? credentialStore.getRefreshToken(config.gmailAccountId);
      if (!refreshToken) throw new Error("No Gmail refresh token found; run life-os email auth first");
      const report = await ingestImportantGmail({
        adapter: new GmailRestAdapter(loadGmailAuthConfig(refreshToken)),
        store: new OperationalStore(config.databasePath),
        accountId: config.gmailAccountId,
        limit,
      });
      console.log(JSON.stringify(report, null, 2));
      return report.failed > 0 ? 1 : 0;
    }
    if (subcommand === "preview-extraction") {
      const args = parseFlags(emailRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      if (!config.gmailEnabled) throw new Error("Gmail ingestion is disabled");
      const refreshToken = Bun.env.GMAIL_REFRESH_TOKEN
        ?? new MacOsKeychainGmailCredentialStore().getRefreshToken(config.gmailAccountId);
      if (!refreshToken) throw new Error("No Gmail refresh token found; run life-os email auth first");
      const preview = await previewGmailExtractionContext({
        adapter: new GmailRestAdapter(loadGmailAuthConfig(refreshToken)),
        store: new OperationalStore(config.databasePath), accountId: config.gmailAccountId,
      });
      console.log(JSON.stringify(preview ?? { message: "No unextracted important messages." }, null, 2));
      return 0;
    }
  }

  if (command === "message") {
    const [subcommand, ...messageRest] = rest;
    const args = parseFlags(messageRest);
    const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
    const adapter = new MacOsMessagesAdapter(config.imessageDatabasePath);
    if (subcommand === "link-person") {
      const sourceConversationId = args.flags.conversation;
      const personId = args.flags.person;
      if (!sourceConversationId || !personId) {
        throw new Error("message link-person requires --conversation <source-id> --person <person-id>");
      }
      const result = linkIMessageConversationToPerson({
        store: new OperationalStore(config.databasePath),
        sourceId: config.imessageSourceId,
        sourceConversationId,
        personId,
        selection: {
          mode: config.imessageSelectionMode,
          conversationIds: config.imessageConversationIds,
        },
      });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (subcommand === "status") {
      const store = new OperationalStore(config.databasePath);
      store.migrate();
      const access = await adapter.checkAccess();
      console.log(JSON.stringify({
        enabled: config.imessageEnabled,
        access,
        selectionMode: config.imessageSelectionMode,
        configuredConversationIds: config.imessageConversationIds.length,
        ...new IMessageStore(store).inspectionSummary(config.imessageSourceId),
      }, null, 2));
      return access.ok ? 0 : 1;
    }
    if (subcommand === "conversations") {
      const access = await adapter.checkAccess();
      if (!access.ok) throw new Error(access.reason ?? "Messages database is unavailable");
      const conversations = await adapter.listConversations(parseLimit(args.flags.limit, 50, 200));
      console.log(JSON.stringify(conversations.map((conversation) => ({
        sourceConversationId: conversation.sourceConversationId,
        displayName: conversation.displayName,
        service: conversation.service,
        participantCount: conversation.participants.length,
        latestSourceRowId: conversation.latestSourceRowId,
      })), null, 2));
      return 0;
    }
    if (subcommand === "ingest") {
      if (!config.imessageEnabled) {
        throw new Error("iMessage ingestion is disabled; set LIFE_OS_IMESSAGE_ENABLED=true");
      }
      const report = await ingestIMessageChanges({
        adapter, store: new OperationalStore(config.databasePath),
        sourceId: config.imessageSourceId,
        selection: {
          mode: config.imessageSelectionMode,
          conversationIds: config.imessageConversationIds,
        },
        limit: parseLimit(args.flags.limit, 500, 5000),
      });
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    if (subcommand === "preview-extraction") {
      if (!config.imessageEnabled) throw new Error("Messages ingestion is disabled");
      const preview = await previewIMessageExtractionContext({
        adapter, store: new OperationalStore(config.databasePath),
        sourceId: config.imessageSourceId,
        selection: {
          mode: config.imessageSelectionMode,
          conversationIds: config.imessageConversationIds,
        },
      });
      console.log(JSON.stringify(preview ?? { message: "No unextracted Messages sources." }, null, 2));
      return 0;
    }
    if (subcommand === "review-extractions") {
      const store = new OperationalStore(config.databasePath);
      store.migrate();
      console.log(JSON.stringify(new IMessageStore(store).extractionReview(
        config.imessageSourceId, { timeZone: config.timezone },
      ), null, 2));
      return 0;
    }
    if (subcommand === "triage") {
      if (!config.imessageEnabled) throw new Error("Messages ingestion is disabled");
      const report = await triageIMessageServiceConversations({
        adapter, store: new OperationalStore(config.databasePath),
        sourceId: config.imessageSourceId,
        selection: {
          mode: config.imessageSelectionMode,
          conversationIds: config.imessageConversationIds,
        },
        limit: parseLimit(args.flags.limit, 100, 1000),
      });
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
  }

  if (command === "calendar") {
    const [subcommand, ...calendarRest] = rest;
    const args = parseFlags(calendarRest);
    const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
    const store = new OperationalStore(config.databasePath); store.migrate();
    if (subcommand === "status") {
      console.log(JSON.stringify(new CalendarStore(store).summary(config.gmailAccountId), null, 2));
      return 0;
    }
    if (subcommand === "ingest") {
      if (!config.calendarEnabled) throw new Error("Calendar ingestion is disabled; set LIFE_OS_CALENDAR_ENABLED=true");
      const refreshToken = Bun.env.GMAIL_REFRESH_TOKEN
        ?? new MacOsKeychainGmailCredentialStore().getRefreshToken(config.gmailAccountId);
      if (!refreshToken) throw new Error("Google refresh token unavailable; run email auth first");
      const report = await ingestCalendar({ adapter: new GoogleCalendarRestAdapter(loadGmailAuthConfig(refreshToken)),
        store, accountId: config.gmailAccountId });
      console.log(JSON.stringify(report, null, 2)); return 0;
    }
  }

  if (command === "telegram") {
    const [subcommand, ...telegramRest] = rest;
    const args = parseFlags(telegramRest);
    const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
    const store = new OperationalStore(config.databasePath); store.migrate();
    if (subcommand === "status") {
      console.log(JSON.stringify(new TelegramStore(store).status(config.telegramSourceId), null, 2));
      return 0;
    }
    if (subcommand === "ingest") {
      if (!config.telegramEnabled) throw new Error("Telegram ingestion is disabled; set LIFE_OS_TELEGRAM_ENABLED=true");
      if (config.telegramChatIds.length === 0) throw new Error("Telegram ingestion requires LIFE_OS_TELEGRAM_CHAT_IDS");
      const limitPerChat = Number(args.flags.limit ?? "50");
      if (!Number.isInteger(limitPerChat) || limitPerChat < 1 || limitPerChat > 100) {
        throw new Error("--limit must be an integer between 1 and 100");
      }
      const client = new NativeTdJsonClient({ ...loadTelegramTdLibConfig(),
        databaseDirectory: config.telegramDatabaseDirectory });
      try {
        const report = await ingestTelegramChanges({ adapter: new TdLibTelegramAdapter(client), store,
          sourceId: config.telegramSourceId, chatIds: config.telegramChatIds, limitPerChat });
        console.log(JSON.stringify(report, null, 2));
        return 0;
      } finally { client.close(); }
    }
  }

  printUsage();
  return 2;
}

function parseLimit(value: string | undefined, fallback: number, maximum: number): number {
  const limit = Number(value ?? fallback);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`--limit must be an integer between 1 and ${maximum}`);
  }
  return limit;
}

function parseFlags(args: string[]): { flags: Record<string, string>; positionals: string[] } {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = next;
        index += 1;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { flags, positionals };
}

function formatReport(report: HealthReport, vaultPath: string): string {
  const lines = ["Life OS Health Report", `Vault: ${vaultPath}`, ""];
  for (const finding of report.findings) lines.push(formatFinding(finding));
  lines.push("", `Errors: ${report.errorCount}`, `Warnings: ${report.warningCount}`, `Overall health: ${report.healthScore}%`);
  return lines.join("\n");
}

function formatFinding(finding: Finding): string {
  const parts = [symbols[finding.severity], finding.message];
  if (finding.path) parts.push(finding.path);
  if (finding.detail) parts.push(`(${finding.detail})`);
  return parts.join(" - ");
}

function formatStateReport(report: StateRebuildReport): string {
  const lines = [
    "Life OS State Rebuild",
    `Scanned: ${report.scanned}`,
    `Changed: ${report.changed}`,
    `Unchanged: ${report.unchanged}`,
    `Projected: ${report.projected} (${report.projects} projects, ${report.people} people, ${report.tasks} tasks)`,
    `Task candidates: ${report.taskCandidates}`,
    `Chief-of-staff state version: ${report.chiefOfStaffStateVersion}`,
  ];
  for (const issue of report.issues) lines.push(`ERR - ${issue.path} - ${issue.message}`);
  return lines.join("\n");
}

function formatProposal(proposal: ProposalRecord): string {
  return [
    "",
    `Proposal: ${proposal.proposalId} [${proposal.lifecycleState}]`,
    `Action: ${proposal.actionId} (${proposal.permissionClass})`,
    `Target: ${proposal.targetPath}`,
    `Expected hash: ${proposal.targetHash}`,
    "Proposed diff:",
    String(proposal.arguments.preview ?? "(no preview)"),
    `Approve: life-os approve ${proposal.proposalId} --action ${proposal.actionId} --vault <path>`,
  ].join("\n");
}

function assertBriefingItemExists(content: Record<string, unknown>, itemKey: string): void {
  const match = itemKey.match(/^([A-Za-z][A-Za-z0-9]*):(\d+)$/);
  if (!match) throw new Error("briefing item key must use section:index");
  const section = content[match[1]!];
  const index = Number(match[2]);
  if (!Array.isArray(section) || index >= section.length) throw new Error(`briefing item not found: ${itemKey}`);
}

function printUsage(): void {
  console.error(`Usage:
  life-os doctor --vault <path> [--json]
  life-os db migrate --vault <path>
  life-os state rebuild --vault <path> [--json]
  life-os state show <projects|people|tasks|chief-of-staff> --vault <path>
  life-os normalize propose --vault <path> [--json]
  life-os normalize tasks --vault <path> [--json]
  life-os policy bootstrap --vault <path> [--json]
  life-os policy apply-bootstrap --confirm <exact-set-token> --vault <path>
  life-os review [proposal-id] --vault <path>
  life-os approve <proposal-id> --action <action-id> --vault <path>
  life-os apply <proposal-id> --vault <path>
  life-os undo <action-id> --vault <path>
  life-os briefing morning --vault <path> [--json]
  life-os briefing feedback <state-id> --item <section:index> --useful <true|false> --vault <path>
  life-os metrics efficiency --vault <path>
  life-os email auth --vault <path>
  life-os email ingest --vault <path> [--limit <n>]
  life-os email status --vault <path>
  life-os email review-extractions --vault <path>
  life-os email preview-extraction --vault <path>
  life-os message status --vault <path>
  life-os message conversations --vault <path> [--limit <n>]
  life-os message ingest --vault <path> [--limit <n>]
  life-os message link-person --conversation <source-id> --person <person-id> --vault <path>
  life-os message preview-extraction --vault <path>
  life-os message review-extractions --vault <path>
  life-os calendar ingest --vault <path>
  life-os calendar status --vault <path>
  life-os message triage --vault <path> [--limit <n>]
  life-os findings review --vault <path>
  life-os findings dismiss <finding-id> --reason <text> --vault <path>
  life-os findings supersede <finding-id> --replacement <finding-id> --reason <text> --vault <path>
  life-os telegram ingest --vault <path> [--limit <1-100>]
  life-os telegram status --vault <path>`);
}

const exitCode = await main(Bun.argv.slice(2));
process.exit(exitCode);
