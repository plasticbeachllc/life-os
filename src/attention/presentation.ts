import type { AttentionSignal } from "./contract";

export const ATTENTION_PRESENTATION_POLICY_VERSION = "attention-presentation-v1";
export const IMMEDIATE_NOTIFICATION_WINDOW_MS = 4 * 60 * 60 * 1000;

export type PresentationChannel =
  | "suppress"
  | "review_queue"
  | "morning_briefing"
  | "immediate_notification";

export const presentationReasons = [
  "low_confidence",
  "validated_imminent_consequence",
  "high_priority_daily_attention",
  "reviewable_intervention",
  "low_value_no_action",
] as const;

export type PresentationReason = typeof presentationReasons[number];

export interface ValidatedInterruptionContext {
  attention_id: string;
  consequence: "safety_risk" | "irreversible_loss";
  effective_at: string;
  confidence: number;
  validator: { method: "deterministic" | "validated_reasoning"; version: string };
  content_hash: string;
}

export interface PresentationDecision {
  attention_id: string;
  channel: PresentationChannel;
  reason: PresentationReason;
  explanation: string;
  policy_version: typeof ATTENTION_PRESENTATION_POLICY_VERSION;
}

export function routeAttentionPresentation(input: {
  signals: AttentionSignal[];
  now: Date;
  immediateNotificationsEnabled?: boolean;
  interruptionContexts?: ValidatedInterruptionContext[];
}): PresentationDecision[] {
  const signals = uniqueSignals(input.signals);
  const contexts = interruptionContexts(input.interruptionContexts ?? [], signals);
  const decisions = signals.map((signal) => {
    const interruptionContext = contexts.get(signal.attention_id);
    return routeSignal({
      signal, now: input.now,
      immediateNotificationsEnabled: input.immediateNotificationsEnabled === true,
      ...(interruptionContext ? { interruptionContext } : {}),
    });
  });
  return decisions.sort(compareDecisions);
}

function routeSignal(input: {
  signal: AttentionSignal;
  now: Date;
  immediateNotificationsEnabled: boolean;
  interruptionContext?: ValidatedInterruptionContext;
}): PresentationDecision {
  if (input.signal.confidence < 0.75) {
    return decision(input.signal, "suppress", "low_confidence",
      "The signal does not meet the minimum confidence required for user attention.");
  }
  if (input.immediateNotificationsEnabled
    && input.signal.impact === "high" && input.signal.urgency === "today"
    && isImminent(input.interruptionContext, input.now)) {
    return decision(input.signal, "immediate_notification", "validated_imminent_consequence",
      "An explicitly enabled, validated consequence falls inside the immediate interruption window.");
  }
  if (input.signal.impact === "high" || input.signal.urgency === "today") {
    return decision(input.signal, "morning_briefing", "high_priority_daily_attention",
      "The signal is important or due today, but does not meet the stricter interruption boundary.");
  }
  if (input.signal.impact === "medium"
    || input.signal.suggested_interventions.some((item) => item.readiness !== "unsupported")) {
    return decision(input.signal, "review_queue", "reviewable_intervention",
      "The signal has a useful disposition or intervention that can be reviewed in a batch.");
  }
  return decision(input.signal, "suppress", "low_value_no_action",
    "The signal is low impact, not urgent, and has no currently reviewable intervention.");
}

function interruptionContexts(
  contexts: ValidatedInterruptionContext[], signals: AttentionSignal[],
): Map<string, ValidatedInterruptionContext> {
  const signalIds = new Set(signals.map((signal) => signal.attention_id));
  const result = new Map<string, ValidatedInterruptionContext>();
  for (const context of contexts) {
    if (!signalIds.has(context.attention_id)) {
      throw new Error("interruption context references an unknown attention signal");
    }
    if (result.has(context.attention_id)) {
      throw new Error("duplicate interruption context for attention signal");
    }
    if (context.confidence < 0 || context.confidence > 1
      || !["safety_risk", "irreversible_loss"].includes(context.consequence)
      || !context.validator.version || !/^sha256:/.test(context.content_hash)
      || Number.isNaN(new Date(context.effective_at).getTime())) {
      throw new Error("interruption context validation identity is incomplete");
    }
    result.set(context.attention_id, context);
  }
  return result;
}

function uniqueSignals(signals: AttentionSignal[]): AttentionSignal[] {
  const ids = new Set<string>();
  for (const signal of signals) {
    if (!signal.attention_id || ids.has(signal.attention_id)) {
      throw new Error("attention signal identity must be complete and unique");
    }
    ids.add(signal.attention_id);
  }
  return signals;
}

function isImminent(context: ValidatedInterruptionContext | undefined, now: Date): boolean {
  if (!context || context.confidence < 0.9) return false;
  const effectiveAt = new Date(context.effective_at).getTime();
  const delay = effectiveAt - now.getTime();
  return delay >= 0 && delay <= IMMEDIATE_NOTIFICATION_WINDOW_MS;
}

function decision(
  signal: AttentionSignal, channel: PresentationChannel,
  reason: PresentationReason, explanation: string,
): PresentationDecision {
  return {
    attention_id: signal.attention_id, channel, reason, explanation,
    policy_version: ATTENTION_PRESENTATION_POLICY_VERSION,
  };
}

function compareDecisions(left: PresentationDecision, right: PresentationDecision): number {
  const priority: Record<PresentationChannel, number> = {
    immediate_notification: 0, morning_briefing: 1, review_queue: 2, suppress: 3,
  };
  return priority[left.channel] - priority[right.channel]
    || left.attention_id.localeCompare(right.attention_id);
}
