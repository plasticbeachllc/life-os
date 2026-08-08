import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ObsidianVault } from "../adapters/obsidian";
import { loadConfig } from "../config";
import { OperationalStore } from "../db/store";
import { createIntegrationRegistry } from "../integrations/providers";
import { IntegrationRegistry } from "../integrations/registry";
import { compileUiNotificationBundle } from "../ui/notifications";
import { refreshAfterExtraction } from "../workflows/post-extraction-refresh";
import { refreshToday } from "../workflows/refresh-today";
import { runExtractionPilot } from "../workflows/run-one-extraction";
import {
  evaluateInboxUtility,
  SubscriptionEvaluationAdapter,
  type InboxUtilityEvaluation,
} from "./chief-of-staff";

export interface LiveEvaluationOptions {
  gmail: number;
  imessage: number;
  cases: number;
  model: string;
  outputRoot?: string;
  cwd?: string;
  baselinePath?: string;
  replayDatabasePath?: string;
}

export interface LiveEvaluationReport {
  formatVersion: "life-os-live-evaluation-v1";
  mode: "fresh" | "replay";
  runId: string;
  startedAt: string;
  completedAt: string;
  isolation: { database: "new_disposable"; vault: "read_only"; providerPermissions: "read_only" };
  ingestion?: {
    refreshedAt: string;
    providers: Array<{ provider: string; status: string; changed: number; unchanged: number }>;
    state: { projected: number; retired: number; issueCount: number };
    modelCalls: 0;
  };
  extraction?: Awaited<ReturnType<typeof runExtractionPilot>>;
  projection: ReturnType<typeof refreshAfterExtraction>;
  inbox: { mode: string; notifications: number; needsYou: number; evaluable: number };
  utility: InboxUtilityEvaluation;
  comparison?: { baselineScore: number | null; scoreDelta: number | null; dimensionDelta: Record<string, number | null> };
}

export async function runLiveEvaluation(options: LiveEvaluationOptions): Promise<{
  report: LiveEvaluationReport;
  runDirectory: string;
  reportPath: string;
  databasePath: string;
}> {
  validateOptions(options);
  const startedAt = new Date().toISOString();
  const runId = `evaluation_${crypto.randomUUID()}`;
  const root = secureOutputRoot(options.outputRoot);
  const runDirectory = join(root, runId);
  if (existsSync(runDirectory)) throw new Error("evaluation run directory already exists");
  mkdirSync(runDirectory, { mode: 0o700 });
  const databasePath = join(runDirectory, "operational.db");
  const previousDatabasePath = Bun.env.LIFE_OS_DATABASE_PATH;
  Bun.env.LIFE_OS_DATABASE_PATH = databasePath;
  let store: OperationalStore | undefined;
  try {
    const config = loadConfig();
    if (options.replayDatabasePath) copyReplayDatabase(options.replayDatabasePath, databasePath);
    store = new OperationalStore(databasePath);
    store.migrate();
    chmodSync(databasePath, 0o600);
    store.recordRun({ runId, workflow: "chief-of-staff-live-evaluation",
      mode: options.replayDatabasePath ? "isolated_replay" : "isolated_live",
      startedAt, status: "running", modelVersion: options.model });
    let ingestion: Awaited<ReturnType<typeof refreshToday>> | undefined;
    let extraction: Awaited<ReturnType<typeof runExtractionPilot>> | undefined;
    if (!options.replayDatabasePath) {
      const vault = new ObsidianVault(config.vaultPath);
      const registry = boundedRegistry({ gmail: Math.max(options.gmail, 20), imessage: Math.max(options.imessage * 20, 100) });
      ingestion = await refreshToday({ vault, store, vaultPath: config.vaultPath, registry });
      extraction = await runExtractionPilot({
        gmail: config.gmailEnabled ? options.gmail : 0,
        imessage: config.imessageEnabled ? options.imessage : 0,
        model: options.model,
      });
    }
    const projection = refreshAfterExtraction({ store });
    const bundle = compileUiNotificationBundle();
    const utility = await evaluateInboxUtility({
      store,
      runId,
      notifications: bundle.snapshot.notifications,
      candidates: bundle.summaryCandidates,
      adapter: new SubscriptionEvaluationAdapter(options.cwd ?? process.cwd()),
      model: options.model,
      maxCases: options.cases,
    });
    const report: LiveEvaluationReport = {
      formatVersion: "life-os-live-evaluation-v1",
      mode: options.replayDatabasePath ? "replay" : "fresh",
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      isolation: { database: "new_disposable", vault: "read_only", providerPermissions: "read_only" },
      ...(ingestion ? { ingestion: {
        refreshedAt: ingestion.refreshedAt,
        providers: ingestion.providers,
        state: { projected: ingestion.state.projected, retired: ingestion.state.retired,
          issueCount: ingestion.state.issues.length },
        modelCalls: ingestion.modelCalls,
      } } : {}),
      ...(extraction ? { extraction } : {}),
      projection,
      inbox: {
        mode: bundle.snapshot.mode,
        notifications: bundle.snapshot.notifications.length,
        needsYou: bundle.snapshot.notifications.filter((item) => item.category === "needs_you").length,
        evaluable: utility.cases.length,
      },
      utility,
      ...(options.baselinePath ? { comparison: compareReports(readReport(options.baselinePath), utility) } : {}),
    };
    const reportPath = join(runDirectory, "report.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    store.recordRun({ runId, workflow: "chief-of-staff-live-evaluation",
      mode: options.replayDatabasePath ? "isolated_replay" : "isolated_live",
      startedAt, completedAt: report.completedAt, status: utility.failed > 0 ? "partial" : "completed", modelVersion: options.model });
    return { report, runDirectory, reportPath, databasePath };
  } catch (error) {
    store?.recordRun({ runId, workflow: "chief-of-staff-live-evaluation",
      mode: options.replayDatabasePath ? "isolated_replay" : "isolated_live",
      startedAt, completedAt: new Date().toISOString(), status: "failed", modelVersion: options.model });
    throw error;
  } finally {
    if (previousDatabasePath === undefined) delete Bun.env.LIFE_OS_DATABASE_PATH;
    else Bun.env.LIFE_OS_DATABASE_PATH = previousDatabasePath;
  }
}

function copyReplayDatabase(source: string, target: string): void {
  const path = resolve(source);
  const stats = lstatSync(path);
  const uid = process.getuid?.();
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0
    || uid !== undefined && stats.uid !== uid) {
    throw new Error("replay database must be a private, owned, non-symlink file");
  }
  copyFileSync(path, target);
  chmodSync(target, 0o600);
}

function boundedRegistry(limits: Record<string, number>): IntegrationRegistry {
  const registry = new IntegrationRegistry();
  for (const integration of createIntegrationRegistry().list()) {
    registry.register({ ...integration,
      ingest: (input) => integration.ingest({ ...input,
        limit: Math.min(limits[integration.id] ?? integration.limit?.default ?? 50, integration.limit?.maximum ?? 50) }),
    });
  }
  return registry;
}

function secureOutputRoot(configured?: string): string {
  const root = resolve(configured ?? join(Bun.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "life-os", "evaluations"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stats = lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new Error("evaluation output root must be a private, non-symlink directory with mode 700");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) throw new Error("evaluation output root must be owned by the current user");
  return root;
}

function readReport(path: string): LiveEvaluationReport {
  const resolved = resolve(path);
  const stats = lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new Error("baseline report must be a private, non-symlink file");
  }
  const value = JSON.parse(readFileSync(resolved, "utf8")) as LiveEvaluationReport;
  if (value.formatVersion !== "life-os-live-evaluation-v1" || !value.utility) throw new Error("baseline report is incompatible");
  return value;
}

function compareReports(baseline: LiveEvaluationReport, current: InboxUtilityEvaluation): NonNullable<LiveEvaluationReport["comparison"]> {
  const dimensionDelta: Record<string, number | null> = {};
  for (const [name, score] of Object.entries(current.dimensions)) {
    const prior = baseline.utility.dimensions[name as keyof typeof baseline.utility.dimensions];
    dimensionDelta[name] = score === null || prior === null ? null : Math.round((score - prior) * 10) / 10;
  }
  return {
    baselineScore: baseline.utility.score,
    scoreDelta: current.score === null || baseline.utility.score === null ? null
      : Math.round((current.score - baseline.utility.score) * 10) / 10,
    dimensionDelta,
  };
}

function validateOptions(options: LiveEvaluationOptions): void {
  for (const [name, value, maximum] of [["gmail", options.gmail, 20], ["imessage", options.imessage, 20], ["cases", options.cases, 20]] as const) {
    if (!Number.isInteger(value) || value < (name === "cases" ? 1 : 0) || value > maximum) {
      throw new Error(`${name} must be an integer between ${name === "cases" ? 1 : 0} and ${maximum}`);
    }
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(options.model)) throw new Error("model name is invalid");
  if (options.replayDatabasePath && options.baselinePath
    && resolve(options.replayDatabasePath) === resolve(options.baselinePath)) {
    throw new Error("replay database and baseline report must be different files");
  }
}
