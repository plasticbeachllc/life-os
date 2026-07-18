import { existsSync } from "node:fs";

import { loadConfig } from "../config";
import { schemaVersion } from "../db/schema";
import { OperationalStore } from "../db/store";
import { browserProposalReview } from "../effects/review-projection";
import { FindingStore } from "../findings/store";
import { createIntegrationRegistry } from "../integrations/providers";
import { sha256Text } from "../util/hashing";
import { WorkRepository } from "../work/repository";

export type UiDataState = "loading" | "live" | "empty" | "stale" | "partial" | "failed" | "setup_required";

export interface UiWorkspaceSnapshot {
  mode: UiDataState;
  generatedAt: string;
  sources: Array<{
    provider: string; enabled: boolean; health: "healthy" | "disabled" | "partial" | "failed";
    summary: string;
  }>;
  attention: Array<{
    category: "reply" | "open_loop" | "date" | "relationship" | "project";
    count: number; freshness: string;
  }>;
  findings: { total: number; active: number; byKind: Record<string, number>; items: Array<{
    id: string; kind: string; status: string; dueDate: string | null;
  }> };
  state: { projectionCount: number; freshness: string; provenance: string };
  proposals: ReturnType<typeof browserProposalReview>[];
  actions: Array<{
    id: string; effectType: string; state: string; result: "succeeded" | "failed" | "unknown";
    undo: "available" | "used" | "unavailable"; createdAt: string;
  }>;
  work: {
    pending: number; leased: number; failed: number; oldestPendingAgeSeconds: number | null;
    failureCategories: Record<string, number>;
  };
  refresh: { available: boolean; label: string };
  message?: string;
}

export async function compileUiWorkspace(now = new Date()): Promise<UiWorkspaceSnapshot> {
  const empty = baseSnapshot(now);
  try {
    const config = loadConfig();
    if (!existsSync(config.databasePath)) return { ...empty, mode: "setup_required", message: "Operational state has not been initialized." };
    const store = new OperationalStore(config.databasePath);
    if (store.getSchemaVersion() !== schemaVersion) {
      return { ...empty, mode: "setup_required", message: "Operational state must be reset and rebuilt." };
    }
    const sourceResults = await Promise.all(createIntegrationRegistry().list().map(async (integration) => {
      try {
        const status = await integration.status();
        return {
          provider: displayProvider(integration.id), enabled: status.enabled,
          health: status.enabled ? sourceHealth(status.details) : "disabled" as const,
          summary: status.enabled ? "Configured read-only source" : "Not enabled",
        };
      } catch {
        return { provider: displayProvider(integration.id), enabled: true,
          health: "failed" as const, summary: "Status check failed safely" };
      }
    }));
    const findingReview = new FindingStore(store).review();
    const attentionState = store.getCurrentDerivedState("finding_attention_state");
    const chief = store.getCurrentDerivedState("chief_of_staff_state");
    const currentStates = [
      ...store.listCurrentDerivedStates("project_state"),
      ...store.listCurrentDerivedStates("person_state"),
      ...store.listCurrentDerivedStates("task_state"),
      ...(attentionState ? [attentionState] : []), ...(chief ? [chief] : []),
    ];
    const freshnessDate = currentStates.map((state) => state.createdAt).sort().at(-1);
    const freshness = freshnessDate ? relativeFreshness(freshnessDate, now) : "No compact state";
    const openLoops = objects(attentionState?.content.open_loops);
    const work = new WorkRepository(store).status(now);
    const proposals = store.listPendingProposals().slice(0, 20).map(browserProposalReview);
    const actions = store.listRecentActionReviews(20).map((action) => ({
      id: uiId("action", action.actionId), effectType: action.effectType,
      state: action.lifecycleState,
      result: action.ok === undefined ? "unknown" as const : action.ok ? "succeeded" as const : "failed" as const,
      undo: action.undone ? "used" as const : action.undoAvailable ? "available" as const : "unavailable" as const,
      createdAt: action.createdAt,
    }));
    const active = findingReview.byStatus.active ?? 0;
    const partial = sourceResults.some((source) => source.health === "failed" || source.health === "partial")
      || work.byState.failed > 0;
    const stale = freshnessDate ? now.getTime() - new Date(freshnessDate).getTime() > 36 * 60 * 60 * 1000 : false;
    const hasData = findingReview.total + currentStates.length + proposals.length + actions.length + work.total > 0;
    return {
      mode: partial ? "partial" : stale ? "stale" : hasData ? "live" : "empty",
      generatedAt: now.toISOString(), sources: sourceResults,
      attention: [
        queue("reply", openLoops.filter((item) => item.kind === "explicit_request").length, freshness),
        queue("open_loop", Number(attentionState?.content.open_loop_count ?? 0), freshness),
        queue("date", Number(attentionState?.content.overdue_count ?? 0), freshness),
        queue("relationship", findingReview.byKind.relationship_update ?? 0, freshness),
        queue("project", array(chief?.content.stalled_projects).length, freshness),
      ],
      findings: { total: findingReview.total, active, byKind: findingReview.byKind,
        items: findingReview.findings.slice(0, 10).map((finding) => ({
          id: uiId("finding", finding.findingId), kind: finding.kind,
          status: finding.status, dueDate: finding.dueDate,
        })) },
      state: { projectionCount: currentStates.length, freshness,
        provenance: "Canonical Markdown and metadata-only provider projections" },
      proposals, actions,
      work: { pending: work.byState.pending, leased: work.byState.leased,
        failed: work.byState.failed, oldestPendingAgeSeconds: work.oldestPendingAgeSeconds,
        failureCategories: work.failureCategories },
      refresh: { available: true, label: "Refresh Today" },
    };
  } catch {
    return { ...empty, mode: "failed", message: "The sanitized workspace projection is unavailable." };
  }
}

function baseSnapshot(now: Date): UiWorkspaceSnapshot {
  return { mode: "empty", generatedAt: now.toISOString(), sources: [], attention: [],
    findings: { total: 0, active: 0, byKind: {}, items: [] },
    state: { projectionCount: 0, freshness: "No compact state", provenance: "Canonical sources" },
    proposals: [], actions: [], work: { pending: 0, leased: 0, failed: 0,
      oldestPendingAgeSeconds: null, failureCategories: {} },
    refresh: { available: false, label: "Refresh unavailable" } };
}

function sourceHealth(details: unknown): "healthy" | "partial" | "failed" {
  const value = details && typeof details === "object" ? details as Record<string, unknown> : {};
  const access = value.access && typeof value.access === "object" ? value.access as Record<string, unknown> : {};
  if (access.ok === false || value.lastRunStatus === "failed") return "failed";
  if (Number(value.partialFailures ?? 0) > 0 || Number(value.failed ?? 0) > 0) return "partial";
  return "healthy";
}

function displayProvider(value: string): string {
  return ({ gmail: "Email", imessage: "Messages", calendar: "Calendar", telegram: "Telegram" } as Record<string, string>)[value] ?? "Source";
}

function queue(category: UiWorkspaceSnapshot["attention"][number]["category"], count: number, freshness: string) {
  return { category, count, freshness };
}

function relativeFreshness(value: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return "Updated within the hour";
  if (minutes < 24 * 60) return `Updated ${Math.floor(minutes / 60)} hours ago`;
  return `Updated ${Math.floor(minutes / 1440)} days ago`;
}

function uiId(kind: string, identity: string): string {
  return `ui_${sha256Text(`${kind}:${identity}`).slice(7, 27)}`;
}

function objects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
