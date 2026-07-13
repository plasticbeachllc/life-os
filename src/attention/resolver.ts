import type { DerivedStateRecord } from "../db/store";
import type { ActiveFindingProjectionInput } from "../findings/store";
import { sha256Value } from "../util/hashing";
import type {
  AttentionSignal, AttentionSignalType, SuggestedIntervention,
  ValidatedCommunicationContext, ValidatedFindingRelation,
} from "./contract";

const commitmentKinds = new Set(["user_commitment", "other_commitment"]);
const responseKinds = new Set(["explicit_request", "open_loop"]);
export const MIN_ATTENTION_CONFIDENCE = 0.75;

export interface AttentionResolution {
  signals: AttentionSignal[];
  suppressed: {
    tracked_commitments: number;
    low_confidence_findings: number;
    missing_communication_context: number;
    unsupported_findings: number;
  };
}

interface TaskInput {
  taskId: string;
  description: string;
  dueDate: string | null;
  status: string;
}

export function resolveAttention(input: {
  activeFindings: ActiveFindingProjectionInput[];
  tasks: DerivedStateRecord[];
  now: Date;
  communicationContexts?: ValidatedCommunicationContext[];
  relations?: ValidatedFindingRelation[];
}): AttentionResolution {
  const date = input.now.toISOString().slice(0, 10);
  const tasks = input.tasks.map(taskInput).filter((task) => task.status === "open");
  const findingById = new Map(input.activeFindings.map((finding) => [finding.findingId, finding]));
  const communicationContexts = indexCommunicationContexts(input.communicationContexts ?? [], findingById);
  const relations = validateRelations(input.relations ?? [], findingById);
  const responseTargetIds = new Set(relations
    .filter((relation) => ["responds_to", "resolves", "supersedes"].includes(relation.kind)
      && responseKinds.has(findingById.get(relation.to_finding_id)!.kind))
    .map((relation) => relation.to_finding_id));
  const resolutionRelations = relations.filter((relation) =>
    ["resolves", "supersedes"].includes(relation.kind)
    && commitmentKinds.has(findingById.get(relation.to_finding_id)!.kind));
  const resolvedTargetIds = new Set(resolutionRelations.map((relation) => relation.to_finding_id));
  const commitments = input.activeFindings.filter((finding) => commitmentKinds.has(finding.kind));
  const actionable = commitments.filter((finding) =>
    finding.confidence >= MIN_ATTENTION_CONFIDENCE && !resolvedTargetIds.has(finding.findingId));
  const groups = groupFindings(actionable);
  const signals: AttentionSignal[] = [];
  let trackedCommitments = 0;

  for (const [targetId, targetRelations] of groupRelationsByTarget(resolutionRelations)) {
    const target = findingById.get(targetId)!;
    const sources = [...new Set(targetRelations.map((relation) => relation.from_finding_id))]
      .map((findingId) => findingById.get(findingId)!)
      .sort((left, right) => left.findingId.localeCompare(right.findingId));
    const matchingTasks = tasks.filter((task) => normalize(task.description) === normalize(target.statement));
    signals.push(signal({
      type: "commitment_resolved", findings: [target, ...sources], tasks: matchingTasks,
      title: "Commitment may be resolved", summary: target.statement,
      impact: "medium", urgency: "soon",
      confidence: Math.min(...targetRelations.map((relation) => relation.confidence)),
      explanation: targetRelations.some((relation) => relation.kind === "supersedes")
        ? "A validated relation says a newer finding supersedes this active commitment."
        : "A validated relation says another finding resolves this active commitment.",
      interventions: [
        reviewResolution(),
        ...(matchingTasks.length > 0 ? [completeTask()] : []),
      ],
    }));
  }

  const responseGroups = groupResponseFindings(input.activeFindings.filter((finding) => {
    if (!responseKinds.has(finding.kind) || finding.owner !== "user"
      || finding.confidence < MIN_ATTENTION_CONFIDENCE
      || responseTargetIds.has(finding.findingId)) return false;
    const context = communicationContexts.get(finding.findingId);
    return context?.direction === "incoming"
      && context.response_expectation === "required"
      && context.response_state === "awaiting_response";
  }));
  for (const responseGroup of responseGroups) {
    const finding = responseGroup[0]!;
    const overdue = responseGroup.some((candidate) =>
      candidate.dueDate !== null && candidate.dueDate < date);
    signals.push(signal({
      type: overdue ? "response_overdue" : "response_needed",
      findings: responseGroup, tasks: [],
      title: overdue ? "Response is overdue" : "Response is needed",
      summary: finding.statement,
      impact: overdue ? "high" : "medium",
      urgency: overdue || finding.dueDate === date ? "today" : "soon",
      explanation: responseGroup.length > 1
        ? "Repeated findings describe the same required response; they are combined into one attention item."
        : "Validated incoming communication context requires a response and records no response yet.",
      interventions: [draftReply()],
    }));
  }

  for (const group of groups) {
    const finding = group[0]!;
    const matchingTasks = tasks.filter((task) => normalize(task.description) === normalize(finding.statement));
    if (group.length > 1 || matchingTasks.length > 1) {
      signals.push(signal({
        type: "duplicate_commitment", findings: group, tasks: matchingTasks,
        title: "Possible duplicate commitment",
        summary: finding.statement,
        impact: "low", urgency: "none",
        explanation: group.length > 1
          ? "The same normalized commitment appears in more than one active finding."
          : "The same normalized commitment appears in more than one open task.",
        interventions: [reviewDuplicates()],
      }));
      continue;
    }

    if (finding.dueDate !== null && finding.dueDate < date) {
      signals.push(signal({
        type: "commitment_at_risk", findings: group, tasks: matchingTasks,
        title: "Commitment is overdue", summary: finding.statement,
        impact: "high", urgency: "today",
        explanation: "The explicit due date has passed and the underlying finding is still active.",
        interventions: finding.owner === "user"
          ? matchingTasks.length === 0 ? [createTask(group)] : []
          : [draftFollowUp()],
      }));
      continue;
    }

    if (finding.owner === "user") {
      if (matchingTasks.length === 0) {
        signals.push(signal({
          type: "untracked_user_commitment", findings: group, tasks: [],
          title: "Commitment is not tracked", summary: finding.statement,
          impact: finding.dueDate === date ? "high" : "medium",
          urgency: finding.dueDate === date ? "today" : "soon",
          explanation: "No open task has the same normalized description as this active user commitment.",
          interventions: [createTask(group)],
        }));
      } else if (finding.dueDate !== null && matchingTasks[0]!.dueDate === null) {
        signals.push(signal({
          type: "deadline_not_tracked", findings: group, tasks: matchingTasks,
          title: "Task is missing its deadline", summary: finding.statement,
          impact: "medium", urgency: finding.dueDate === date ? "today" : "soon",
          explanation: "The active finding has an explicit due date, but the matching open task does not.",
          interventions: [updateTaskDate()],
        }));
      } else {
        trackedCommitments += 1;
      }
      continue;
    }

    if (finding.owner === "other") {
      signals.push(signal({
        type: "waiting_on_other", findings: group, tasks: matchingTasks,
        title: "Waiting on someone else", summary: finding.statement,
        impact: "medium", urgency: finding.dueDate === date ? "today" : "soon",
        explanation: "Another person owns this active commitment and no resolution has been recorded.",
        interventions: [draftFollowUp()],
      }));
    }
  }

  signals.sort(compareSignals);
  return {
    signals,
    suppressed: {
      tracked_commitments: trackedCommitments,
      low_confidence_findings: input.activeFindings.filter((finding) =>
        (commitmentKinds.has(finding.kind) || responseKinds.has(finding.kind))
        && finding.confidence < MIN_ATTENTION_CONFIDENCE).length,
      missing_communication_context: input.activeFindings.filter((finding) =>
        responseKinds.has(finding.kind) && finding.owner === "user"
        && finding.confidence >= MIN_ATTENTION_CONFIDENCE
        && !communicationContexts.has(finding.findingId)).length,
      unsupported_findings: input.activeFindings.filter((finding) =>
        !commitmentKinds.has(finding.kind) && !responseKinds.has(finding.kind)
        && !relations.some((relation) => relation.from_finding_id === finding.findingId)).length,
    },
  };
}

function groupRelationsByTarget(
  relations: ValidatedFindingRelation[],
): Map<string, ValidatedFindingRelation[]> {
  const groups = new Map<string, ValidatedFindingRelation[]>();
  for (const relation of relations) {
    groups.set(relation.to_finding_id, [...(groups.get(relation.to_finding_id) ?? []), relation]);
  }
  return new Map([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function compareSignals(left: AttentionSignal, right: AttentionSignal): number {
  const urgency = { today: 0, soon: 1, none: 2 } as const;
  const impact = { high: 0, medium: 1, low: 2 } as const;
  return urgency[left.urgency] - urgency[right.urgency]
    || impact[left.impact] - impact[right.impact]
    || left.type.localeCompare(right.type)
    || left.attention_id.localeCompare(right.attention_id);
}

function indexCommunicationContexts(
  contexts: ValidatedCommunicationContext[],
  findings: Map<string, ActiveFindingProjectionInput>,
): Map<string, ValidatedCommunicationContext> {
  const result = new Map<string, ValidatedCommunicationContext>();
  for (const context of contexts) {
    if (!findings.has(context.finding_id)) {
      throw new Error("communication context references a non-active finding");
    }
    if (result.has(context.finding_id)) {
      throw new Error("duplicate communication context for finding");
    }
    if (!context.validator.version || !/^sha256:/.test(context.content_hash)) {
      throw new Error("communication context validation identity is incomplete");
    }
    result.set(context.finding_id, context);
  }
  return result;
}

function validateRelations(
  relations: ValidatedFindingRelation[],
  findings: Map<string, ActiveFindingProjectionInput>,
): ValidatedFindingRelation[] {
  const relationIds = new Set<string>();
  const result: ValidatedFindingRelation[] = [];
  for (const relation of relations) {
    if (!relation.relation_id || relationIds.has(relation.relation_id)) {
      throw new Error("finding relation identity must be unique");
    }
    if (relation.from_finding_id === relation.to_finding_id
      || !findings.has(relation.from_finding_id) || !findings.has(relation.to_finding_id)) {
      throw new Error("finding relation must connect distinct active findings");
    }
    if (relation.confidence < 0 || relation.confidence > 1
      || !relation.validator.version || !/^sha256:/.test(relation.content_hash)) {
      throw new Error("finding relation validation identity is incomplete");
    }
    relationIds.add(relation.relation_id);
    if (relation.confidence >= MIN_ATTENTION_CONFIDENCE) result.push(relation);
  }
  return result;
}

function groupFindings(findings: ActiveFindingProjectionInput[]): ActiveFindingProjectionInput[][] {
  const groups = new Map<string, ActiveFindingProjectionInput[]>();
  for (const finding of findings) {
    const key = `${finding.kind}:${finding.owner}:${normalize(finding.statement)}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups.values()].map((group) =>
    group.sort((left, right) => left.findingId.localeCompare(right.findingId)));
}

function groupResponseFindings(
  findings: ActiveFindingProjectionInput[],
): ActiveFindingProjectionInput[][] {
  const groups = new Map<string, ActiveFindingProjectionInput[]>();
  for (const finding of findings) {
    const key = `${finding.owner}:${normalize(finding.statement)}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => group.sort((left, right) => left.findingId.localeCompare(right.findingId)));
}

function taskInput(state: DerivedStateRecord): TaskInput {
  return {
    taskId: state.entityId ?? String(state.content.task_id ?? ""),
    description: String(state.content.description ?? ""),
    dueDate: typeof state.content.due_date === "string" ? state.content.due_date : null,
    status: String(state.content.status ?? ""),
  };
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function signal(input: {
  type: AttentionSignalType;
  findings: ActiveFindingProjectionInput[];
  tasks: TaskInput[];
  title: string;
  summary: string;
  impact: AttentionSignal["impact"];
  urgency: AttentionSignal["urgency"];
  confidence?: number;
  explanation: string;
  interventions: SuggestedIntervention[];
}): AttentionSignal {
  const findingIds = input.findings.map((finding) => finding.findingId).sort();
  const subjectRefs = input.tasks
    .filter((task) => task.taskId)
    .map((task) => ({ type: "task" as const, id: task.taskId }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const identity = { type: input.type, findingIds, subjectRefs };
  return {
    attention_id: `attention_${sha256Value(identity).slice("sha256:".length, "sha256:".length + 24)}`,
    type: input.type, title: input.title, summary: input.summary,
    finding_ids: findingIds, subject_refs: subjectRefs,
    owner: owner(input.findings[0]!.owner),
    confidence: Math.min(input.confidence ?? 1, ...input.findings.map((finding) => finding.confidence)),
    impact: input.impact, urgency: input.urgency,
    due_date: input.findings.map((finding) => finding.dueDate).find((date) => date !== null) ?? null,
    explanation: input.explanation,
    ambiguities: [...new Set(input.findings.flatMap((finding) => finding.ambiguities))].sort(),
    suggested_interventions: input.interventions,
  };
}

function owner(value: string): AttentionSignal["owner"] {
  return ["user", "other", "shared", "unknown"].includes(value)
    ? value as AttentionSignal["owner"] : "unknown";
}

function createTask(findings: ActiveFindingProjectionInput[]): SuggestedIntervention {
  const ambiguous = findings.some((finding) => finding.ambiguities.length > 0);
  return {
    kind: "create_task", rationale: "Track the active user commitment in canonical task state.",
    expected_benefit: "The commitment can participate in planning, due-date review, and completion.",
    consequence_of_delay: "The commitment may remain outside the user's task system.",
    permission_class: "yellow",
    readiness: ambiguous ? "needs_clarification" : "ready",
    reversible: true,
  };
}

function updateTaskDate(): SuggestedIntervention {
  return {
    kind: "update_task_date", rationale: "Bring the matching task's date in line with explicit evidence.",
    expected_benefit: "The deadline can participate in deterministic planning and overdue checks.",
    consequence_of_delay: "The task may not surface at the intended time.",
    permission_class: "yellow", readiness: "unsupported", reversible: true,
  };
}

function draftFollowUp(): SuggestedIntervention {
  return {
    kind: "draft_follow_up", rationale: "Prepare a reviewable follow-up without sending anything.",
    expected_benefit: "The user can close or advance the waiting loop with less effort.",
    consequence_of_delay: "The external commitment may remain unresolved.",
    permission_class: "prepare", readiness: "unsupported", reversible: true,
  };
}

function draftReply(): SuggestedIntervention {
  return {
    kind: "draft_reply", rationale: "Prepare a reviewable response without sending anything.",
    expected_benefit: "The user can respond with less effort while retaining control of the message.",
    consequence_of_delay: "The incoming request may remain unanswered.",
    permission_class: "prepare", readiness: "unsupported", reversible: true,
  };
}

function reviewDuplicates(): SuggestedIntervention {
  return {
    kind: "review_duplicates", rationale: "Confirm whether the records describe one obligation.",
    expected_benefit: "Avoid duplicate tasks and repeated attention.",
    consequence_of_delay: null,
    permission_class: "read", readiness: "ready", reversible: true,
  };
}

function reviewResolution(): SuggestedIntervention {
  return {
    kind: "review_resolution", rationale: "Confirm the validated relationship before closing canonical state.",
    expected_benefit: "Resolved work can leave active attention without silently rewriting history.",
    consequence_of_delay: "The resolved commitment may continue to appear active.",
    permission_class: "read", readiness: "ready", reversible: true,
  };
}

function completeTask(): SuggestedIntervention {
  return {
    kind: "complete_task", rationale: "Align the matching canonical task with validated resolution evidence.",
    expected_benefit: "Completed work stops participating in open-task planning.",
    consequence_of_delay: "The task may continue to appear open.",
    permission_class: "yellow", readiness: "unsupported", reversible: true,
  };
}
