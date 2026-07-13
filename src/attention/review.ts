import type { DerivedStateRecord } from "../db/store";
import {
  attentionSignalTypes, interventionKinds,
  type AttentionSignalType, type InterventionKind,
} from "./contract";
import {
  ATTENTION_PRESENTATION_POLICY_VERSION,
  presentationReasons,
  type PresentationChannel, type PresentationReason,
} from "./presentation";

export const MAX_ATTENTION_REVIEW_ITEMS = 50;

export interface AttentionReviewIntervention {
  kind: InterventionKind;
  rationale: string;
  expectedBenefit: string;
  consequenceOfDelay: string | null;
  permissionClass: "read" | "prepare" | "yellow";
  readiness: "ready" | "needs_clarification" | "unsupported";
  reversible: boolean;
}

export interface AttentionReviewItem {
  attentionId: string;
  type: AttentionSignalType;
  title: string;
  summary: string;
  owner: "user" | "other" | "shared" | "unknown";
  confidence: number;
  impact: "low" | "medium" | "high";
  urgency: "none" | "soon" | "today";
  dueDate: string | null;
  explanation: string;
  ambiguities: string[];
  findingIds: string[];
  interventions: AttentionReviewIntervention[];
  presentation: {
    channel: "review_queue";
    reason: PresentationReason;
    explanation: string;
    policyVersion: typeof ATTENTION_PRESENTATION_POLICY_VERSION;
  };
}

export interface AttentionReview {
  asOf: string;
  stateVersion: number;
  counts: {
    byChannel: Record<PresentationChannel, number>;
    byType: Partial<Record<AttentionSignalType, number>>;
    reviewQueue: number;
    returned: number;
    omitted: number;
  };
  items: AttentionReviewItem[];
}

export function compileAttentionReview(state: DerivedStateRecord): AttentionReview {
  if (state.stateType !== "finding_attention_state") {
    throw new Error("attention review requires current finding attention state");
  }
  const signals = indexSignals(state.content.signals);
  const decisions = indexDecisions(state.content.presentation, signals);
  const byChannel = emptyChannelCounts();
  const byType: Partial<Record<AttentionSignalType, number>> = {};
  const queued: AttentionReviewItem[] = [];
  for (const decision of decisions.values()) {
    byChannel[decision.channel] += 1;
    const signal = signals.get(decision.attentionId)!;
    if (decision.channel !== "review_queue") continue;
    byType[signal.type] = (byType[signal.type] ?? 0) + 1;
    queued.push(reviewItem(signal, decision));
  }
  queued.sort(compareReviewItems);
  const items = queued.slice(0, MAX_ATTENTION_REVIEW_ITEMS);
  return {
    asOf: isoString(state.content.as_of), stateVersion: state.stateVersion,
    counts: {
      byChannel, byType, reviewQueue: queued.length,
      returned: items.length, omitted: queued.length - items.length,
    },
    items,
  };
}

interface SafeSignal {
  attentionId: string;
  type: AttentionSignalType;
  title: string;
  summary: string;
  owner: AttentionReviewItem["owner"];
  confidence: number;
  impact: AttentionReviewItem["impact"];
  urgency: AttentionReviewItem["urgency"];
  dueDate: string | null;
  explanation: string;
  ambiguities: string[];
  findingIds: string[];
  interventions: AttentionReviewIntervention[];
}

interface SafeDecision {
  attentionId: string;
  channel: PresentationChannel;
  reason: PresentationReason;
  explanation: string;
}

function indexSignals(value: unknown): Map<string, SafeSignal> {
  if (!Array.isArray(value)) throw new Error("attention review signals are missing");
  const result = new Map<string, SafeSignal>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("attention review signal is invalid");
    const record = item as Record<string, unknown>;
    const attentionId = exactId(record.attention_id, /^attention_[A-Za-z0-9_-]+$/, "attention");
    if (result.has(attentionId)) throw new Error("attention review signal identity is duplicated");
    if (!attentionSignalTypes.includes(record.type as never)) throw new Error("attention review signal type is invalid");
    const confidence = number(record.confidence, 0, 1, "confidence");
    const impact = oneOf(record.impact, ["low", "medium", "high"] as const, "impact");
    const urgency = oneOf(record.urgency, ["none", "soon", "today"] as const, "urgency");
    const owner = oneOf(record.owner, ["user", "other", "shared", "unknown"] as const, "owner");
    result.set(attentionId, {
      attentionId, type: record.type as AttentionSignalType,
      title: bounded(record.title, 120), summary: bounded(record.summary, 240), owner,
      confidence, impact, urgency,
      dueDate: record.due_date === null ? null : dateString(record.due_date),
      explanation: bounded(record.explanation, 320),
      ambiguities: stringArray(record.ambiguities, 10, 200),
      findingIds: idArray(record.finding_ids, /^finding_[A-Za-z0-9_-]+$/, 20),
      interventions: interventions(record.suggested_interventions),
    });
  }
  return result;
}

function indexDecisions(
  value: unknown, signals: Map<string, SafeSignal>,
): Map<string, SafeDecision> {
  if (!Array.isArray(value)) throw new Error("attention review presentation decisions are missing");
  const result = new Map<string, SafeDecision>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("attention review presentation decision is invalid");
    const record = item as Record<string, unknown>;
    const attentionId = exactId(record.attention_id, /^attention_[A-Za-z0-9_-]+$/, "attention");
    if (!signals.has(attentionId)) throw new Error("attention review presentation references an unknown signal");
    if (result.has(attentionId)) throw new Error("attention review presentation identity is duplicated");
    if (record.policy_version !== ATTENTION_PRESENTATION_POLICY_VERSION) {
      throw new Error("attention review presentation policy is stale");
    }
    result.set(attentionId, {
      attentionId,
      channel: oneOf(record.channel,
        ["suppress", "review_queue", "morning_briefing", "immediate_notification"] as const, "channel"),
      reason: oneOf(record.reason, presentationReasons, "reason"),
      explanation: bounded(record.explanation, 320),
    });
  }
  if (result.size !== signals.size) throw new Error("attention review presentation is incomplete");
  return result;
}

function reviewItem(signal: SafeSignal, decision: SafeDecision): AttentionReviewItem {
  return {
    attentionId: signal.attentionId, type: signal.type, title: signal.title,
    summary: signal.summary, owner: signal.owner, confidence: signal.confidence,
    impact: signal.impact, urgency: signal.urgency, dueDate: signal.dueDate,
    explanation: signal.explanation, ambiguities: signal.ambiguities,
    findingIds: signal.findingIds, interventions: signal.interventions,
    presentation: {
      channel: "review_queue", reason: decision.reason,
      explanation: decision.explanation,
      policyVersion: ATTENTION_PRESENTATION_POLICY_VERSION,
    },
  };
}

function interventions(value: unknown): AttentionReviewIntervention[] {
  if (!Array.isArray(value) || value.length > 10) throw new Error("attention review interventions are invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("attention review intervention is invalid");
    const record = item as Record<string, unknown>;
    if (!interventionKinds.includes(record.kind as never)) throw new Error("attention review intervention kind is invalid");
    return {
      kind: record.kind as InterventionKind,
      rationale: bounded(record.rationale, 240),
      expectedBenefit: bounded(record.expected_benefit, 240),
      consequenceOfDelay: record.consequence_of_delay === null
        ? null : bounded(record.consequence_of_delay, 240),
      permissionClass: oneOf(record.permission_class, ["read", "prepare", "yellow"] as const, "permission class"),
      readiness: oneOf(record.readiness, ["ready", "needs_clarification", "unsupported"] as const, "readiness"),
      reversible: boolean(record.reversible, "reversible"),
    };
  });
}

function compareReviewItems(left: AttentionReviewItem, right: AttentionReviewItem): number {
  const urgency = { today: 0, soon: 1, none: 2 } as const;
  const impact = { high: 0, medium: 1, low: 2 } as const;
  return urgency[left.urgency] - urgency[right.urgency]
    || impact[left.impact] - impact[right.impact]
    || left.type.localeCompare(right.type)
    || left.attentionId.localeCompare(right.attentionId);
}

function emptyChannelCounts(): Record<PresentationChannel, number> {
  return { suppress: 0, review_queue: 0, morning_briefing: 0, immediate_notification: 0 };
}

function bounded(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("attention review text is invalid");
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1).trimEnd()}…`;
}

function exactId(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`attention review ${label} ID is invalid`);
  return value;
}

function idArray(value: unknown, pattern: RegExp, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new Error("attention review finding IDs are invalid");
  }
  const ids = value.map((item) => exactId(item, pattern, "finding"));
  if (new Set(ids).size !== ids.length) throw new Error("attention review finding IDs are duplicated");
  return ids;
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error("attention review text list is invalid");
  return value.map((item) => bounded(item, maxLength));
}

function dateString(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) {
    throw new Error("attention review due date is invalid");
  }
  return value;
}

function isoString(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw new Error("attention review timestamp is invalid");
  }
  return value;
}

function number(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`attention review ${label} is invalid`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`attention review ${label} is invalid`);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`attention review ${label} is invalid`);
  }
  return value as T[number];
}
