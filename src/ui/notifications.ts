import { existsSync } from "node:fs";

import { loadConfig } from "../config";
import { CalendarStore } from "../calendar/store";
import { OperationalStore } from "../db/store";
import { GmailStore } from "../gmail/store";
import { currentEmailExtractionIdentity } from "../gmail/extraction-contract";
import { sha256Text } from "../util/hashing";

export type UiNotificationCategory = "for_you" | "activity" | "approvals";
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

export function compileUiNotifications(now = new Date()): UiNotificationSnapshot {
  try {
    const config = loadConfig();
    if (!existsSync(config.databasePath)) {
      return setupSnapshot(now, "LifeOS has not created its operational database yet.");
    }

    const store = new OperationalStore(config.databasePath);
    if (store.getSchemaVersion() === undefined) {
      return setupSnapshot(now, "LifeOS needs a database migration before the Inbox can load.");
    }

    const notifications: UiNotification[] = [];
    const gmail = new GmailStore(store);
    const calendar = new CalendarStore(store);

    for (const proposal of store.listPendingProposals().slice(0, 10)) {
      notifications.push({
        id: uiId("proposal", proposal.proposalId),
        kind: "proposal",
        category: "for_you",
        tone: "question",
        status: "open",
        title: "Internal change awaits review",
        summary: compactText(String(proposal.arguments.preview ?? "A LifeOS change is ready for review."), 180),
        detail: "Current policy still requires approval for this internal change.",
        relativeTime: relativeTime(proposal.createdAt, now),
        primaryAction: { kind: "discuss", label: "Discuss" },
        secondaryAction: { kind: "dismiss", label: "Dismiss" },
      });
    }

    if (config.gmailEnabled) {
      const status = gmail.inspectionSummary(config.gmailAccountId, currentEmailExtractionIdentity);
      const review = gmail.extractionReview(config.gmailAccountId, currentEmailExtractionIdentity);

      if (status.unextracted > 0) {
        notifications.push({
          id: uiId("gmail-unextracted", String(status.unextracted)),
          kind: "email",
          category: "for_you",
          tone: "question",
          status: "open",
          title: `${status.unextracted} important email${status.unextracted === 1 ? "" : "s"} waiting`,
          summary: "Ingestion is complete, but structured extraction still needs to run through the subscription agent.",
          relativeTime: status.lastRunCompletedAt ? relativeTime(status.lastRunCompletedAt, now) : "Not yet processed",
          primaryAction: { kind: "discuss", label: "Ask LifeOS" },
        });
      }

      for (const extraction of review.extractions.slice(0, 12)) {
        if (extraction.promptInjectionDetected) {
          notifications.push({
            id: uiId("gmail-untrusted", extraction.extractionId),
            kind: "email",
            category: "for_you",
            tone: "question",
            status: "open",
            title: "Untrusted email instruction detected",
            summary: "LifeOS isolated an instruction in provider content instead of treating it as a command.",
            detail: "No task or proposal was created from the instruction.",
            relativeTime: relativeTime(extraction.createdAt, now),
            primaryAction: { kind: "discuss", label: "Discuss" },
            secondaryAction: { kind: "dismiss", label: "Dismiss" },
          });
          continue;
        }

        if (shouldSurfaceClarification(extraction)) {
          notifications.push({
            id: uiId("gmail-ambiguity", extraction.extractionId),
            kind: "email",
            category: "for_you",
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
        category: "for_you",
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

    return { mode: "live", generatedAt: now.toISOString(), notifications };
  } catch (error) {
    return {
      mode: "unavailable",
      generatedAt: now.toISOString(),
      notifications: [systemErrorNotification(error)],
      error: safeError(error),
    };
  }
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
      category: "for_you",
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
    category: "for_you",
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
