import type { ContextManifest } from "../context/builder";
import type { OperationalStore } from "../db/store";
import { ModelGateway, type ModelAdapter } from "../orchestration/model-gateway";
import { routeModel } from "../orchestration/model-router";
import { runSubscriptionHost } from "../orchestration/subscription-host";
import {
  normalizeNotificationOpening,
  notificationOpeningInstructions,
  notificationOpeningOutputSchema,
  type NotificationAgentSummary,
} from "../ui/notification-opening";
import type { UiNotification, UiNotificationSummaryCandidate } from "../ui/notifications";
import { sha256Value } from "../util/hashing";

export const CHIEF_OF_STAFF_EVALUATION_VERSION = "chief-of-staff-utility-v1";
export const CHIEF_OF_STAFF_JUDGE_PROMPT_VERSION = "chief-of-staff-judge-v1";

export const utilityIssueCodes = [
  "vague_actor",
  "missing_source_action",
  "generic_next_step",
  "unsupported_claim",
  "missing_priority_signal",
  "redundant_opening",
  "unnecessary_question",
  "overloaded",
  "weak_context",
] as const;
export type UtilityIssueCode = typeof utilityIssueCodes[number];

export interface UtilityScores {
  relevance: number;
  specificity: number;
  actionability: number;
  grounding: number;
  prioritization: number;
  concision: number;
}

export interface EvaluatedInboxCase {
  caseRef: string;
  kind: UiNotification["kind"];
  category: UiNotification["category"];
  status: "completed" | "failed";
  scores?: UtilityScores;
  score?: number;
  issueCodes: Array<UtilityIssueCode | "opening_generation_failed" | "judge_failed">;
  signals: {
    hasNamedParticipants: boolean;
    hasSourceAction: boolean;
    actionRequired: boolean;
    contextItems: number;
  };
}

export interface InboxUtilityEvaluation {
  version: string;
  cases: EvaluatedInboxCase[];
  completed: number;
  failed: number;
  score: number | null;
  dimensions: Record<keyof UtilityScores, number | null>;
  issueCounts: Record<string, number>;
  recommendations: string[];
}

export class SubscriptionEvaluationAdapter implements ModelAdapter {
  constructor(private readonly cwd: string) {}

  async complete(input: Parameters<ModelAdapter["complete"]>[0]): Promise<{
    output: unknown;
    usage: { inputTokens: number; outputTokens: number };
  }> {
    const output = await runSubscriptionHost({
      prompt: `${input.instructions}\n\nGrounded context:\n${JSON.stringify(input.context)}`,
      model: input.model,
      cwd: this.cwd,
      outputSchema: input.outputSchema?.schema ?? { type: "object" },
    });
    return {
      output,
      usage: {
        inputTokens: Math.ceil((input.instructions.length + JSON.stringify(input.context).length) / 4),
        outputTokens: Math.ceil(JSON.stringify(output).length / 4),
      },
    };
  }
}

export async function evaluateInboxUtility(input: {
  store: OperationalStore;
  runId: string;
  notifications: UiNotification[];
  candidates: UiNotificationSummaryCandidate[];
  adapter: ModelAdapter;
  model: string;
  maxCases: number;
}): Promise<InboxUtilityEvaluation> {
  if (!Number.isInteger(input.maxCases) || input.maxCases < 1 || input.maxCases > 20) {
    throw new Error("evaluation case limit must be between 1 and 20");
  }
  const gateway = new ModelGateway(input.store, input.adapter);
  const route = routeModel({
    deterministicResolutionAvailable: false,
    ambiguity: 0.3,
    consequenceOfError: 0.4,
    contextComplexity: 0.5,
    requiresSynthesis: true,
    structuredExtraction: false,
  }, { extractionModel: input.model, reasoningModel: input.model });
  if (route.model !== input.model) throw new Error("evaluation router selected an unexpected model");
  const notifications = new Map(input.notifications.map((notification) => [notification.id, notification]));
  const selected = input.candidates
    .filter((candidate) => notifications.get(candidate.notificationId)?.category === "needs_you")
    .slice(0, input.maxCases);
  const cases: EvaluatedInboxCase[] = [];

  for (const candidate of selected) {
    const notification = notifications.get(candidate.notificationId);
    if (!notification) continue;
    const groundedContext = candidate.manifest.includedItems.map((item) => item.content);
    const base = caseBase(notification, candidate);
    let opening: NotificationAgentSummary;
    try {
      const output = await gateway.complete({
        runId: input.runId,
        workflow: "chief-of-staff-evaluation-opening",
        taskType: "bounded_discussion_opening",
        model: input.model,
        promptVersion: candidate.promptVersion,
        sourceHash: candidate.sourceHash,
        instructions: notificationOpeningInstructions(candidate.actionRequired),
        manifest: cloneManifest(candidate.manifest),
        outputSchema: { name: "notification_opening", schema: notificationOpeningOutputSchema },
      });
      opening = normalizeNotificationOpening(JSON.stringify(output), candidate.actionRequired);
    } catch {
      cases.push({ ...base, status: "failed", issueCodes: ["opening_generation_failed"] });
      continue;
    }

    try {
      const output = await gateway.complete({
        runId: input.runId,
        workflow: "chief-of-staff-utility-judge",
        taskType: "structured_utility_evaluation",
        model: input.model,
        promptVersion: CHIEF_OF_STAFF_JUDGE_PROMPT_VERSION,
        sourceHash: sha256Value({ source: candidate.sourceHash, opening }),
        instructions: judgeInstructions(candidate.actionRequired, opening),
        manifest: cloneManifest(candidate.manifest),
        outputSchema: { name: "chief_of_staff_utility", schema: judgeOutputSchema },
        validateOutput: validateJudgeOutput,
      });
      const judged = output as { scores: UtilityScores; issueCodes: UtilityIssueCode[] };
      cases.push({ ...base, status: "completed", scores: judged.scores,
        score: scoreDimensions(judged.scores), issueCodes: judged.issueCodes });
    } catch {
      cases.push({ ...base, status: "failed", issueCodes: ["judge_failed"] });
    }
  }

  return aggregate(cases);
}

function caseBase(notification: UiNotification, candidate: UiNotificationSummaryCandidate): Omit<EvaluatedInboxCase, "status" | "issueCodes"> {
  const grounding = candidate.manifest.includedItems.map((item) => item.content);
  return {
    caseRef: sha256Value({ notificationId: candidate.notificationId, sourceHash: candidate.sourceHash }).slice(7, 23),
    kind: notification.kind,
    category: notification.category,
    signals: {
      hasNamedParticipants: JSON.stringify(grounding).includes("participant_labels")
        && !/"participant_labels"\s*:\s*\[\s*\]/.test(JSON.stringify(grounding)),
      hasSourceAction: Boolean(notification.sourceAction),
      actionRequired: candidate.actionRequired,
      contextItems: candidate.manifest.includedItems.length,
    },
  };
}

function cloneManifest(manifest: ContextManifest): ContextManifest {
  return { ...manifest, manifestId: `${manifest.manifestId}_eval_${crypto.randomUUID()}` };
}

function judgeInstructions(actionRequired: boolean, opening: NotificationAgentSummary): string {
  return `Act as a strict evaluator of a personal chief-of-staff assistant. Evaluate the discussion opening against its grounded context, not against facts you know independently.

Score each dimension from 1 (harmful or unusable) to 5 (excellent): relevance, specificity, actionability, grounding, prioritization, and concision.
- Reward concrete names or roles when the context supplies them, a proportionate next step, calibrated uncertainty, and clear judgment.
- Penalize invented claims, bland restatement, vague actors, generic advice, unnecessary questions, or missing source/follow-up affordances.
- actionRequired is expected to be ${actionRequired}; judge whether the language correctly reflects that state.
- issueCodes may contain only the allowed enum values and must be empty when no material problem exists.

Opening under evaluation:
${JSON.stringify(opening)}

Return only the structured score object. Do not repeat, quote, summarize, or explain any personal/source content.`;
}

const scoreProperties = Object.fromEntries(
  ["relevance", "specificity", "actionability", "grounding", "prioritization", "concision"]
    .map((name) => [name, { type: "integer", minimum: 1, maximum: 5 }]),
);

const judgeOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scores", "issueCodes"],
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(scoreProperties),
      properties: scoreProperties,
    },
    issueCodes: {
      type: "array",
      maxItems: utilityIssueCodes.length,
      items: { type: "string", enum: utilityIssueCodes },
    },
  },
} as const;

function validateJudgeOutput(output: unknown): void {
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("utility evaluation must be an object");
  const record = output as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "scores" && key !== "issueCodes")) throw new Error("unexpected utility evaluation field");
  const scores = record.scores as Record<string, unknown> | undefined;
  const names = Object.keys(scoreProperties) as Array<keyof UtilityScores>;
  if (!scores || typeof scores !== "object" || Array.isArray(scores)
    || Object.keys(scores).length !== names.length
    || names.some((name) => !Number.isInteger(scores[name]) || Number(scores[name]) < 1 || Number(scores[name]) > 5)) {
    throw new Error("utility scores are invalid");
  }
  if (!Array.isArray(record.issueCodes) || record.issueCodes.some((item) => !utilityIssueCodes.includes(item as UtilityIssueCode))) {
    throw new Error("utility issue codes are invalid");
  }
}

function scoreDimensions(scores: UtilityScores): number {
  return Math.round(Object.values(scores).reduce((sum, score) => sum + score, 0) / 30 * 100);
}

function aggregate(cases: EvaluatedInboxCase[]): InboxUtilityEvaluation {
  const completedCases = cases.filter((item): item is EvaluatedInboxCase & { scores: UtilityScores; score: number } =>
    item.status === "completed" && Boolean(item.scores) && item.score !== undefined);
  const dimensionNames = Object.keys(scoreProperties) as Array<keyof UtilityScores>;
  const dimensions = Object.fromEntries(dimensionNames.map((name) => [name, completedCases.length
    ? round(completedCases.reduce((sum, item) => sum + item.scores[name], 0) / completedCases.length)
    : null])) as Record<keyof UtilityScores, number | null>;
  const issueCounts: Record<string, number> = {};
  for (const item of cases) for (const issue of item.issueCodes) issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
  return {
    version: CHIEF_OF_STAFF_EVALUATION_VERSION,
    cases,
    completed: completedCases.length,
    failed: cases.length - completedCases.length,
    score: completedCases.length ? round(completedCases.reduce((sum, item) => sum + item.score, 0) / completedCases.length) : null,
    dimensions,
    issueCounts,
    recommendations: recommendations(issueCounts),
  };
}

function recommendations(issueCounts: Record<string, number>): string[] {
  const advice: Partial<Record<string, string>> = {
    vague_actor: "Improve identity resolution and carry participant labels into attention context.",
    missing_source_action: "Expose a safe source link or concrete follow-up affordance when available.",
    generic_next_step: "Tighten discussion prompts around one specific, executable next move.",
    unsupported_claim: "Strengthen evidence binding and calibrated uncertainty in generated advice.",
    missing_priority_signal: "Add due date, consequence, and urgency signals to prioritization context.",
    redundant_opening: "Make the opening add judgment instead of repeating the card.",
    unnecessary_question: "Ask only questions whose answers materially change the next step.",
    overloaded: "Reduce context and output to the smallest decision-relevant unit.",
    weak_context: "Improve context retrieval before changing prose or presentation.",
  };
  return Object.entries(issueCounts)
    .filter(([code, count]) => count > 0 && advice[code])
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([code]) => advice[code]!);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
