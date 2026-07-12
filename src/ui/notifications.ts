import { existsSync } from "node:fs";

import { loadConfig } from "../config";
import { CalendarStore } from "../calendar/store";
import { OperationalStore } from "../db/store";
import { GmailStore } from "../gmail/store";
import { currentEmailExtractionIdentity } from "../gmail/extraction-contract";
import { buildContext, type ContextManifest } from "../context/builder";
import { modelCacheKey } from "../orchestration/cache";
import { routeModel } from "../orchestration/model-router";
import { sha256Text, sha256Value } from "../util/hashing";

export const UI_NOTIFICATION_SUMMARY_MODEL = "gpt-5.6-luna";
export const UI_NOTIFICATION_SUMMARY_PROMPT_VERSION = "ui-notification-summary-v2-sentences";
export const UI_NOTIFICATION_SUMMARY_SCHEMA_VERSION = "ui-notification-summary-schema-v2";
export const UI_NOTIFICATION_SUMMARY_POLICY_VERSION = "ui-read-only-v1";

export type UiNotificationCategory = "needs_you" | "activity" | "approvals";
export type UiNotificationTone = "question" | "receipt" | "proposal" | "update";

export interface UiNotification {
  id: string;
  kind: "email" | "calendar" | "proposal" | "system" | "task";
  category: UiNotificationCategory;
  tone: UiNotificationTone;
  status: "open" | "resolved";
  title: string;
  summary: string;
  detail?: string;
  agentSummary?: { sentences: string[]; actionRequired: boolean };
  relativeTime: string;
  primaryAction?: { kind: "resolve" | "review" | "discuss"; label: string };
  secondaryAction?: { kind: "dismiss"; label: string };
}

export interface UiNotificationSnapshot {
  mode: "live" | "setup_required" | "unavailable";
  generatedAt: string;
  notifications: UiNotification[];
  error?: string;
}

export interface UiNotificationSummaryCandidate {
  notificationId: string;
  cacheKey: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  policyVersion: string;
  sourceHash: string;
  manifest: ContextManifest;
  actionRequired: boolean;
  cachedSummary?: { sentences: string[]; actionRequired: boolean };
}

export interface UiNotificationBundle {
  snapshot: UiNotificationSnapshot;
  summaryCandidates: UiNotificationSummaryCandidate[];
}

export function compileUiNotifications(now = new Date()): UiNotificationSnapshot {
  return compileUiNotificationBundle(now).snapshot;
}

export function compileUiNotificationBundle(now = new Date()): UiNotificationBundle {
  try {
    const config = loadConfig();
    if (!existsSync(config.databasePath)) {
      return { snapshot: setupSnapshot(now, "LifeOS has not created its operational database yet."), summaryCandidates: [] };
    }

    const store = new OperationalStore(config.databasePath);
    if (store.getSchemaVersion() === undefined) {
      return { snapshot: setupSnapshot(now, "LifeOS needs a database migration before the Inbox can load."), summaryCandidates: [] };
    }

    const notifications: UiNotification[] = [];
    const gmail = new GmailStore(store);
    const calendar = new CalendarStore(store);

    for (const proposal of store.listPendingProposals().slice(0, 10)) {
      notifications.push({
        id: uiId("proposal", proposal.proposalId),
        kind: "proposal",
        category: "approvals",
        tone: "proposal",
        status: "open",
        title: "Internal change awaits review",
        summary: compactText(String(proposal.arguments.preview ?? "A LifeOS change is ready for review."), 180),
        detail: "Current policy still requires approval for this internal change.",
        relativeTime: relativeTime(proposal.createdAt, now),
        primaryAction: { kind: "review", label: "Review" },
        secondaryAction: { kind: "dismiss", label: "Dismiss" },
      });
    }

    if (config.gmailEnabled) {
      const status = gmail.inspectionSummary(config.gmailAccountId, currentEmailExtractionIdentity);
      const review = gmail.extractionReview(config.gmailAccountId, currentEmailExtractionIdentity);

      for (const extraction of review.extractions.slice(0, 12)) {
        if (extraction.promptInjectionDetected) {
          notifications.push({
            id: uiId("gmail-untrusted", extraction.extractionId),
            kind: "email",
            category: "activity",
            tone: "update",
            status: "resolved",
            title: "Untrusted email instruction detected",
            summary: "LifeOS isolated an instruction in provider content instead of treating it as a command.",
            detail: "No task or proposal was created from the instruction.",
            relativeTime: relativeTime(extraction.createdAt, now),
          });
          continue;
        }

        if (shouldSurfaceClarification(extraction)) {
          notifications.push({
            id: uiId("gmail-ambiguity", extraction.extractionId),
            kind: "email",
            category: "needs_you",
            tone: "question",
            status: "open",
            title: "Email needs clarification",
            summary: compactText(extraction.unresolved[0] ?? "LifeOS could not resolve one detail.", 180),
            detail: compactText(extraction.summary, 140),
            relativeTime: relativeTime(extraction.createdAt, now),
            primaryAction: { kind: "resolve", label: "Resolve" },
            secondaryAction: { kind: "dismiss", label: "Ignore" },
          });
        }
      }

      if (status.lastRunCompletedAt) {
        notifications.push({
          id: uiId("gmail-run", status.lastRunCompletedAt),
          kind: "email",
          category: "activity",
          tone: "update",
          status: status.lastRunStatus === "completed" ? "resolved" : "open",
          title: status.lastRunStatus === "completed" ? "Email ingestion completed" : "Email ingestion needs attention",
          summary: `${status.messages} metadata-only message record${status.messages === 1 ? "" : "s"} retained; message bodies are not stored.`,
          relativeTime: relativeTime(status.lastRunCompletedAt, now),
        });
      }
    }

    if (config.calendarEnabled) {
      const status = calendar.summary(config.gmailAccountId);
      notifications.push({
        id: uiId("calendar-status", `${status.events}:${status.unprocessed}`),
        kind: "calendar",
        category: "activity",
        tone: "update",
        status: status.unprocessed === 0 ? "resolved" : "open",
        title: status.unprocessed === 0 ? "Calendar is organized" : "Calendar has new changes",
        summary: `${status.events} upcoming event${status.events === 1 ? "" : "s"} in compact state.`,
        ...(status.unprocessed > 0
          ? { detail: `${status.unprocessed} change${status.unprocessed === 1 ? "" : "s"} waiting for projection.` }
          : {}),
        relativeTime: "Current state",
      });
    }

    const chief = store.getCurrentDerivedState("chief_of_staff_state");
    const risks = arrayOfObjects(chief?.content.active_risks);
    for (const [index, risk] of risks.slice(0, 5).entries()) {
      notifications.push({
        id: uiId("chief-risk", `${chief?.stateId ?? "none"}:${index}`),
        kind: "system",
        category: "needs_you",
        tone: "question",
        status: "open",
        title: "LifeOS noticed a risk",
        summary: compactText(String(risk.summary ?? "An active item may need attention."), 180),
        relativeTime: chief ? relativeTime(chief.createdAt, now) : "Current state",
        primaryAction: { kind: "discuss", label: "Discuss" },
      });
    }

    if (notifications.length === 0) {
      notifications.push({
        id: uiId("system", "all-clear"),
        kind: "system",
        category: "activity",
        tone: "update",
        status: "resolved",
        title: "LifeOS is all clear",
        summary: "No current compact state, ingestion result, or proposal needs your attention.",
        relativeTime: "Now",
      });
    }

    const calendarState = config.calendarEnabled
      ? store.getCurrentDerivedState("calendar_state", config.gmailAccountId)?.content
      : undefined;
    const summaryCandidates = buildSummaryCandidates({
      notifications, store, ...(calendarState ? { calendarState } : {}),
    });
    const cachedById = new Map(summaryCandidates
      .filter((candidate) => candidate.cachedSummary)
      .map((candidate) => [candidate.notificationId, candidate.cachedSummary!]));
    return {
      snapshot: {
        mode: "live",
        generatedAt: now.toISOString(),
        notifications: notifications.map((notification) => {
          const agentSummary = cachedById.get(notification.id);
          return agentSummary ? { ...notification, agentSummary } : notification;
        }),
      },
      summaryCandidates,
    };
  } catch (error) {
    return {
      snapshot: {
        mode: "unavailable",
        generatedAt: now.toISOString(),
        notifications: [systemErrorNotification(error)],
        error: safeError(error),
      },
      summaryCandidates: [],
    };
  }
}

function buildSummaryCandidates(input: {
  notifications: UiNotification[];
  store: OperationalStore;
  calendarState?: Record<string, unknown>;
}): UiNotificationSummaryCandidate[] {
  return input.notifications.map((notification) => {
    const content = {
      notification: {
        kind: notification.kind,
        category: notification.category,
        status: notification.status,
        title: notification.title,
        summary: notification.summary,
        ...(notification.detail ? { detail: notification.detail } : {}),
      },
      ...(notification.kind === "calendar" && input.calendarState
        ? { compact_calendar_state: input.calendarState }
        : {}),
    };
    const sourceHash = sha256Value(content);
    const manifest = buildContext([{
      id: `ui-summary:${notification.id}`,
      category: "entity_state",
      retrievalLevel: notification.kind === "calendar" ? 1 : 0,
      content,
      tokenEstimate: Math.min(900, Math.max(32, Math.ceil(JSON.stringify(content).length / 4))),
      relevance: 1,
      impact: notification.category === "activity" ? 0.3 : 0.9,
      recency: 1,
      sourceRefs: [notification.id],
    }], {
      maxInputTokens: 1_200,
      reservedOutputTokens: 180,
      sourceTokens: 0,
      entityStateTokens: 900,
      recentChangeTokens: 0,
      policyTokens: 0,
      contingencyTokens: 120,
    });
    const route = routeModel({
      deterministicResolutionAvailable: false,
      ambiguity: 0.2,
      consequenceOfError: notification.category === "activity" ? 0.2 : 0.6,
      contextComplexity: 0.3,
      requiresSynthesis: true,
      structuredExtraction: false,
    }, { extractionModel: UI_NOTIFICATION_SUMMARY_MODEL, reasoningModel: UI_NOTIFICATION_SUMMARY_MODEL });
    if (route.model !== UI_NOTIFICATION_SUMMARY_MODEL) throw new Error("notification summary router did not select Luna");
    const cacheKey = modelCacheKey({
      workflow: "ui-notification-summary",
      promptVersion: UI_NOTIFICATION_SUMMARY_PROMPT_VERSION,
      model: route.model,
      sourceHash,
      contextHash: manifest.contextHash,
      schemaVersion: UI_NOTIFICATION_SUMMARY_SCHEMA_VERSION,
      policyVersion: UI_NOTIFICATION_SUMMARY_POLICY_VERSION,
    });
    const cachedSummary = parseCachedSummary(input.store.getModelCache(cacheKey)?.output);
    return { notificationId: notification.id, cacheKey,
      model: UI_NOTIFICATION_SUMMARY_MODEL,
      promptVersion: UI_NOTIFICATION_SUMMARY_PROMPT_VERSION,
      schemaVersion: UI_NOTIFICATION_SUMMARY_SCHEMA_VERSION,
      policyVersion: UI_NOTIFICATION_SUMMARY_POLICY_VERSION,
      sourceHash, manifest,
      actionRequired: notification.category !== "activity",
      ...(cachedSummary ? { cachedSummary } : {}) };
  });
}

function parseCachedSummary(value: unknown): { sentences: string[]; actionRequired: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.sentences) || typeof record.actionRequired !== "boolean") return undefined;
  const sentences = record.sentences
    .filter((sentence): sentence is string => typeof sentence === "string")
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 3);
  return sentences.length > 0 ? { sentences, actionRequired: record.actionRequired } : undefined;
}

export function shouldSurfaceClarification(extraction: {
  classification: string; unresolved: string[];
}): boolean {
  return extraction.classification === "ambiguous" && extraction.unresolved.length > 0;
}

function setupSnapshot(now: Date, summary: string): UiNotificationSnapshot {
  return {
    mode: "setup_required",
    generatedAt: now.toISOString(),
    notifications: [{
      id: uiId("system", "setup"),
      kind: "system",
      category: "needs_you",
      tone: "question",
      status: "open",
      title: "Finish LifeOS setup",
      summary,
      detail: "Run the existing doctor and database migration commands before connecting the UI.",
      relativeTime: "Setup required",
      primaryAction: { kind: "discuss", label: "Ask LifeOS" },
    }],
  };
}

function systemErrorNotification(error: unknown): UiNotification {
  return {
    id: uiId("system", "unavailable"),
    kind: "system",
    category: "needs_you",
    tone: "question",
    status: "open",
    title: "LifeOS Inbox is unavailable",
    summary: safeError(error),
    relativeTime: "Now",
    primaryAction: { kind: "discuss", label: "Ask LifeOS" },
  };
}

function uiId(kind: string, sourceId: string): string {
  return `ui_${sha256Text(`${kind}:${sourceId}`).slice("sha256:".length, "sha256:".length + 20)}`;
}

function compactText(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "LifeOS found an item that needs attention.";
  return compact.length <= max ? compact : `${compact.slice(0, max - 1).trimEnd()}…`;
}

function relativeTime(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown LifeOS error";
  const home = process.env.HOME;
  return compactText(home ? message.replaceAll(home, "~") : message, 180);
}

function arrayOfObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    : [];
}
