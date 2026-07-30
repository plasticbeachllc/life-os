import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore } from "../db/store";
import { newId } from "../util/ids";
import {
  runExtractionPilot,
  type ExtractionPilotReport,
} from "./run-one-extraction";
import { refreshAfterExtraction } from "./post-extraction-refresh";
import { refreshToday, type TodayRefreshReport } from "./refresh-today";

const workflowKey = "ui_sync_process";
const activeStatuses = new Set<SyncProcessStatus>(["queued", "running", "cancellation_requested"]);

export type SyncProcessStatus =
  | "queued"
  | "running"
  | "cancellation_requested"
  | "completed"
  | "partial"
  | "cancelled"
  | "failed"
  | "interrupted";
export type SyncProcessStage = "queued" | "ingesting" | "extracting" | "projecting" | "complete";

export interface SyncProcessState {
  runId: string;
  status: SyncProcessStatus;
  stage: SyncProcessStage;
  requested: { gmail: number; imessage: number };
  extraction: ExtractionPilotReport;
  providers: Array<{ provider: string; status: "ingested" | "disabled" | "failed" }>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  errorCategory?: "configuration" | "ingestion" | "extraction" | "projection" | "internal";
}

export interface SyncProcessView {
  status: SyncProcessStatus;
  stage: SyncProcessStage;
  requested: { gmail: number; imessage: number };
  processed: { gmail: number; imessage: number };
  failed: { gmail: number; imessage: number };
  findings: number;
  unresolved: number;
  providers: SyncProcessState["providers"];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  canCancel: boolean;
}

export class SyncProcessRepository {
  constructor(private readonly store: OperationalStore) {}

  create(input: { gmail: number; imessage: number; model: string; now?: Date }): {
    state: SyncProcessState; created: boolean;
  } {
    validateLimits(input.gmail, input.imessage);
    const db = this.store.open();
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      const current = readState(db);
      if (current && activeStatuses.has(current.status)) {
        db.exec("COMMIT");
        return { state: current, created: false };
      }
      const runId = newId("run");
      const extraction = emptyExtractionReport(input.gmail, input.imessage, input.model);
      const state: SyncProcessState = {
        runId, status: "queued", stage: "queued", requested: { gmail: input.gmail, imessage: input.imessage },
        extraction, providers: [], createdAt: nowIso, updatedAt: nowIso,
      };
      db.query(`
        INSERT INTO runs (
          run_id, workflow, mode, started_at, status, model_version, created_at
        ) VALUES (?, ?, 'user_triggered', ?, 'queued', ?, ?)
      `).run(runId, workflowKey, nowIso, input.model, nowIso);
      writeState(db, state);
      db.exec("COMMIT");
      return { state, created: true };
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }

  get(): SyncProcessState | undefined {
    const db = this.store.open();
    try {
      return readState(db);
    } finally {
      db.close();
    }
  }

  begin(runId: string, now = new Date()): SyncProcessState | undefined {
    return this.update(runId, (state) => {
      if (state.status !== "queued") return state;
      return { ...state, status: "running", stage: "ingesting",
        startedAt: now.toISOString(), updatedAt: now.toISOString() };
    });
  }

  progress(runId: string, patch: Partial<Pick<SyncProcessState,
    "status" | "stage" | "providers" | "extraction" | "errorCategory">>, now = new Date()): SyncProcessState | undefined {
    return this.update(runId, (state) => ({ ...state, ...patch, updatedAt: now.toISOString() }));
  }

  requestCancel(now = new Date()): SyncProcessState | undefined {
    const current = this.get();
    if (!current || !activeStatuses.has(current.status)) return current;
    if (current.status === "queued") return this.finish(current.runId, "cancelled", undefined, now);
    return this.update(current.runId, (state) => ({
      ...state, status: "cancellation_requested", updatedAt: now.toISOString(),
    }));
  }

  finish(runId: string, status: Extract<SyncProcessStatus, "completed" | "partial" | "cancelled" | "failed">,
    errorCategory?: SyncProcessState["errorCategory"], now = new Date()): SyncProcessState | undefined {
    const completedAt = now.toISOString();
    return this.update(runId, (state) => ({
      ...state, status, stage: "complete", updatedAt: completedAt, completedAt,
      ...(errorCategory ? { errorCategory } : {}),
    }), true);
  }

  interrupt(runId: string, now = new Date()): SyncProcessState | undefined {
    const completedAt = now.toISOString();
    return this.update(runId, (state) => {
      if (!activeStatuses.has(state.status)) return state;
      return {
        ...state, status: "interrupted", stage: "complete", updatedAt: completedAt,
        completedAt, errorCategory: "internal",
      };
    }, true);
  }

  private update(runId: string, change: (state: SyncProcessState) => SyncProcessState,
    terminal = false): SyncProcessState | undefined {
    const db = this.store.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const current = readState(db);
      if (!current || current.runId !== runId) {
        db.exec("COMMIT");
        return undefined;
      }
      const next = change(current);
      writeState(db, next);
      if (terminal) completeRun(db, next);
      else db.query("UPDATE runs SET status = ? WHERE run_id = ?").run(next.status, runId);
      db.exec("COMMIT");
      return next;
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }
}

export async function executeSyncProcess(input: {
  store: OperationalStore;
  vault: ObsidianVault;
  vaultPath: string;
  runId: string;
  refresh?: typeof refreshToday;
  extract?: typeof runExtractionPilot;
  project?: typeof refreshAfterExtraction;
}): Promise<SyncProcessState | undefined> {
  const repository = new SyncProcessRepository(input.store);
  const state = repository.begin(input.runId);
  if (!state || state.status !== "running") return state;
  try {
    const refreshed = await (input.refresh ?? refreshToday)({
      vault: input.vault, store: input.store, vaultPath: input.vaultPath,
    });
    repository.progress(input.runId, {
      providers: providerProjection(refreshed),
      stage: "extracting",
    });
    const extraction = await (input.extract ?? runExtractionPilot)({
      ...state.requested,
      model: state.extraction.model,
      shouldStop: () => repository.get()?.status === "cancellation_requested",
      onProgress: (report) => { repository.progress(input.runId, { extraction: report }); },
    });
    const latest = repository.progress(input.runId, { extraction, stage: "projecting" });
    if (latest?.status === "cancellation_requested") {
      return repository.finish(input.runId, "cancelled");
    }
    const providerFailed = latest?.providers.some((provider) => provider.status === "failed") ?? false;
    const extractionFailed = extraction.failed.gmail + extraction.failed.imessage > 0;
    const projection = (input.project ?? refreshAfterExtraction)({ store: input.store });
    const projectionFailed = projection.status === "failed";
    return repository.finish(input.runId,
      providerFailed || extractionFailed || projectionFailed ? "partial" : "completed",
      projectionFailed ? "projection" : undefined);
  } catch {
    // Errors are deliberately categorized rather than persisted verbatim: provider/model errors can
    // contain credentials, paths, source identifiers, or excerpts.
    const stage = repository.get()?.stage;
    const category: SyncProcessState["errorCategory"] = stage === "ingesting" ? "ingestion"
      : stage === "extracting" ? "extraction"
      : stage === "projecting" ? "projection"
      : "internal";
    return repository.finish(input.runId, "failed", category);
  }
}

export function syncProcessView(state: SyncProcessState | undefined): SyncProcessView | undefined {
  if (!state) return undefined;
  return {
    status: state.status,
    stage: state.stage,
    requested: state.requested,
    processed: {
      gmail: state.extraction.completed.gmail + state.extraction.empty.gmail,
      imessage: state.extraction.completed.imessage + state.extraction.empty.imessage,
    },
    failed: state.extraction.failed,
    findings: state.extraction.itemCount,
    unresolved: state.extraction.unresolvedCount,
    providers: state.providers,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    canCancel: activeStatuses.has(state.status),
  };
}

function validateLimits(gmail: number, imessage: number): void {
  if (![gmail, imessage].every((count) => Number.isInteger(count) && count >= 0 && count <= 20)) {
    throw new Error("processing limits must be integers between 0 and 20");
  }
}

function emptyExtractionReport(gmail: number, imessage: number, model: string): ExtractionPilotReport {
  return {
    requested: { gmail, imessage }, completed: { gmail: 0, imessage: 0 },
    empty: { gmail: 0, imessage: 0 }, failed: { gmail: 0, imessage: 0 },
    classifications: {}, itemCount: 0, relationCount: 0, unresolvedCount: 0,
    promptInjectionCount: 0, model,
  };
}

function providerProjection(report: TodayRefreshReport): SyncProcessState["providers"] {
  return report.providers.map(({ provider, status }) => ({ provider, status }));
}

type DatabaseConnection = ReturnType<OperationalStore["open"]>;

function readState(db: DatabaseConnection): SyncProcessState | undefined {
  const row = db.query<{ state_json: string }, [string]>(
    "SELECT state_json FROM workflow_state WHERE workflow = ?",
  ).get(workflowKey);
  if (!row) return undefined;
  const value = JSON.parse(row.state_json) as SyncProcessState;
  if (!value || typeof value !== "object" || typeof value.runId !== "string"
    || !activeStatuses.has(value.status) && !["completed", "partial", "cancelled", "failed", "interrupted"].includes(value.status)) {
    throw new Error("stored sync process state is invalid");
  }
  return value;
}

function writeState(db: DatabaseConnection, state: SyncProcessState): void {
  db.query(`
    INSERT INTO workflow_state (workflow, state_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(workflow) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
  `).run(workflowKey, JSON.stringify(state), state.updatedAt);
}

function completeRun(db: DatabaseConnection, state: SyncProcessState): void {
  db.query("UPDATE runs SET status = ?, completed_at = ? WHERE run_id = ?")
    .run(state.status, state.completedAt ?? state.updatedAt, state.runId);
}
