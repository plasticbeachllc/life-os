#!/usr/bin/env bun

import { ObsidianVault } from "./adapters/obsidian";
import { GmailRestAdapter } from "./adapters/gmail";
import { MacOsMessagesAdapter } from "./adapters/imessage";
import { loadConfig, loadGmailAuthConfig, loadGmailClientConfig } from "./config";
import { OperationalStore } from "./db/store";
import type { Finding, HealthReport, Severity } from "./models/common";
import { proposePolicyBootstrap } from "./workflows/bootstrap-policy";
import { applyPolicyBootstrapSet, pendingPolicyBootstrapSet } from "./workflows/apply-policy-bootstrap-set";
import { runDoctor } from "./workflows/doctor";
import { proposeMetadataNormalization } from "./workflows/normalize-metadata";
import { proposeTaskIdNormalization } from "./workflows/normalize-task-ids";
import { formatMorningBriefing, generateMorningBriefing, type MorningBriefing } from "./workflows/morning-briefing";
import { efficiencyReport } from "./workflows/efficiency-metrics";
import { rebuildState, type StateRebuildReport } from "./workflows/rebuild-state";
import { MacOsKeychainGmailCredentialStore } from "./gmail/keychain";
import { authorizeGmailDesktop } from "./workflows/gmail-auth";
import { GmailStore } from "./gmail/store";
import { currentEmailExtractionIdentity } from "./gmail/extraction-contract";
import { previewGmailExtractionContext } from "./workflows/gmail-extraction-preview";
import { IMessageStore } from "./imessage/store";
import { previewIMessageExtractionContext } from "./workflows/imessage-extraction-preview";
import { triageIMessageServiceConversations } from "./workflows/imessage-deterministic-triage";
import { linkIMessageConversationToPerson } from "./workflows/link-imessage-person";
import { FindingStore } from "./findings/store";
import { rebuildFindingAttentionState } from "./state/finding-attention";
import { rebuildChiefOfStaffState } from "./state/chief-of-staff";
import { WorkRepository } from "./work/repository";
import { createIntegrationRegistry } from "./integrations/providers";
import { runRegisteredIntegrationCommand } from "./cli/integration-commands";
import { formatProposal, runProposalCommand } from "./cli/proposal-commands";

const symbols: Record<Severity, string> = {
  ok: "OK",
  info: "INFO",
  warning: "WARN",
  error: "ERR",
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  const integrationExit = await runRegisteredIntegrationCommand({
    command, rest, registry: createIntegrationRegistry(),
  });
  if (integrationExit !== undefined) return integrationExit;
  const proposalExit = await runProposalCommand({ command, rest });
  if (proposalExit !== undefined) return proposalExit;

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

  if (command === "work") {
    const [subcommand, ...workRest] = rest;
    if (subcommand === "status") {
      const args = parseFlags(workRest);
      const config = loadConfig(args.flags.vault ? { vaultPath: args.flags.vault } : {});
      const store = new OperationalStore(config.databasePath);
      store.migrate();
      console.log(JSON.stringify(new WorkRepository(store).status(), null, 2));
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
      console.log(JSON.stringify(preview ?? { message: "No queued important messages." }, null, 2));
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
      console.log(JSON.stringify(preview ?? { message: "No queued Messages sources." }, null, 2));
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
  life-os work status --vault <path>
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
