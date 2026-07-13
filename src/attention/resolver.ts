import type { DerivedStateRecord } from "../db/store";
import type { ActiveFindingProjectionInput } from "../findings/store";
import { sha256Value } from "../util/hashing";
import type {
  AttentionSignal, AttentionSignalType, SuggestedIntervention,
} from "./contract";

const commitmentKinds = new Set(["user_commitment", "other_commitment"]);
export const MIN_ATTENTION_CONFIDENCE = 0.75;

export interface AttentionResolution {
  signals: AttentionSignal[];
  suppressed: {
    tracked_commitments: number;
    low_confidence_findings: number;
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
}): AttentionResolution {
  const date = input.now.toISOString().slice(0, 10);
  const tasks = input.tasks.map(taskInput).filter((task) => task.status === "open");
  const supported = input.activeFindings.filter((finding) => commitmentKinds.has(finding.kind));
  const actionable = supported.filter((finding) => finding.confidence >= MIN_ATTENTION_CONFIDENCE);
  const groups = groupFindings(actionable);
  const signals: AttentionSignal[] = [];
  let trackedCommitments = 0;

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
      low_confidence_findings: supported.length - actionable.length,
      unsupported_findings: input.activeFindings.length - supported.length,
    },
  };
}

function compareSignals(left: AttentionSignal, right: AttentionSignal): number {
  const urgency = { today: 0, soon: 1, none: 2 } as const;
  const impact = { high: 0, medium: 1, low: 2 } as const;
  return urgency[left.urgency] - urgency[right.urgency]
    || impact[left.impact] - impact[right.impact]
    || left.type.localeCompare(right.type)
    || left.attention_id.localeCompare(right.attention_id);
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
    confidence: Math.min(...input.findings.map((finding) => finding.confidence)),
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

function reviewDuplicates(): SuggestedIntervention {
  return {
    kind: "review_duplicates", rationale: "Confirm whether the records describe one obligation.",
    expected_benefit: "Avoid duplicate tasks and repeated attention.",
    consequence_of_delay: null,
    permission_class: "read", readiness: "ready", reversible: true,
  };
}
