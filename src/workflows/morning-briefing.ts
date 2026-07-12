import type { DerivedStateRecord, OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";
import { newId } from "../util/ids";

export interface BriefingItem {
  summary: string;
  evidenceIds: string[];
}

export interface MorningBriefing {
  date: string;
  generatedAt: string;
  focus: BriefingItem[];
  overdue: BriefingItem[];
  dueToday: BriefingItem[];
  waiting: BriefingItem[];
  peopleDueForContact: BriefingItem[];
  risks: BriefingItem[];
  recentCompletions: BriefingItem[];
  unresolved: BriefingItem[];
  ignoredSummary: string;
  metrics: { modelCalls: 0; inputTokens: 0; outputTokens: 0 };
}

export function generateMorningBriefing(input: {
  store: OperationalStore;
  now?: Date;
}): { state: DerivedStateRecord; cached: boolean } {
  const now = input.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const chief = input.store.getCurrentDerivedState("chief_of_staff_state");
  if (!chief) throw new Error("chief-of-staff state is missing; run state rebuild first");
  const tasks = input.store.listCurrentDerivedStates("task_state");
  const people = input.store.listCurrentDerivedStates("person_state");
  const projects = input.store.listCurrentDerivedStates("project_state");
  const findingAttention = input.store.getCurrentDerivedState("finding_attention_state");
  const dependencies = [
    chief, ...tasks, ...people, ...projects, ...(findingAttention ? [findingAttention] : []),
  ];
  const dependencyHash = sha256Value({
    generatorVersion: "deterministic-morning-briefing-v2",
    date,
    states: dependencies.map((state) => [state.stateId, state.stateVersion]),
  });
  const prior = input.store.getCurrentDerivedState("daily_state", date);
  const startedAt = new Date().toISOString();
  const runId = newId("run");
  if (prior?.sourceHashes.includes(dependencyHash)) {
    input.store.recordRun({
      runId, workflow: "morning_briefing", mode: "deterministic",
      startedAt, completedAt: new Date().toISOString(), status: "cached",
    });
    return { state: prior, cached: true };
  }

  const chiefContent = chief.content;
  const taskById = new Map(tasks.flatMap((task) => task.entityId ? [[task.entityId, task]] : []));
  const personById = new Map(people.flatMap((person) => person.entityId ? [[person.entityId, person]] : []));
  const findingById = new Map(objects(findingAttention?.content.open_loops).map((finding) => [
    String(finding.finding_id ?? ""), finding,
  ]));
  const briefing: MorningBriefing = {
    date,
    generatedAt: now.toISOString(),
    focus: objects(chiefContent.current_priorities).map((item) => ({
      summary: String(item.reason ?? "Current priority"),
      evidenceIds: strings(item.evidence_ids ?? item.entity_id),
    })),
    overdue: attentionItems(
      strings(chiefContent.overdue_commitments), taskById, findingById,
      findingAttention?.stateId, "Overdue",
    ),
    dueToday: tasks
      .filter((task) => task.content.status === "open" && task.content.due_date === date)
      .map((task) => taskItem(task, "Due today")),
    waiting: objects(chiefContent.waiting_items).map((item) => {
      const taskId = String(item.task_id ?? "");
      const task = taskById.get(taskId);
      return task ? taskItem(task, "Waiting") : { summary: `Waiting item ${taskId}`, evidenceIds: [taskId] };
    }),
    peopleDueForContact: strings(chiefContent.people_due_for_contact).map((personId) => {
      const person = personById.get(personId);
      return {
        summary: person ? `Contact ${String(person.content.display_name ?? personId)}` : `Contact ${personId}`,
        evidenceIds: person ? [person.stateId, personId] : [personId],
      };
    }),
    risks: objects(chiefContent.active_risks).map((risk) => ({
      summary: String(risk.summary ?? "Active risk"), evidenceIds: strings(risk.entity_ids),
    })),
    recentCompletions: tasks
      .filter((task) => task.content.status === "completed" && recentDate(task.content.completed_at, date, 7))
      .map((task) => taskItem(task, "Completed")),
    unresolved: strings(chiefContent.unresolved_ambiguities).map((summary) => ({ summary, evidenceIds: [] })),
    ignoredSummary: "Unchanged low-priority state omitted.",
    metrics: { modelCalls: 0, inputTokens: 0, outputTokens: 0 },
  };
  const state: DerivedStateRecord = {
    stateId: newId("state"), stateType: "daily_state", entityId: date,
    stateVersion: (prior?.stateVersion ?? 0) + 1,
    content: briefing as unknown as Record<string, unknown>,
    sourceHashes: [dependencyHash, ...new Set(dependencies.flatMap((state) => state.sourceHashes))],
    generationMethod: "deterministic-morning-briefing-v2", createdAt: now.toISOString(),
  };
  input.store.saveDerivedState(state);
  input.store.recordRun({
    runId, workflow: "morning_briefing", mode: "deterministic",
    startedAt, completedAt: new Date().toISOString(), status: "completed",
  });
  return { state, cached: false };
}

export function formatMorningBriefing(briefing: MorningBriefing, cached: boolean): string {
  const lines = [`Morning Briefing - ${briefing.date}${cached ? " (cached)" : ""}`];
  section(lines, "Focus", briefing.focus);
  section(lines, "Due Today", briefing.dueToday);
  section(lines, "Overdue", briefing.overdue);
  section(lines, "Waiting", briefing.waiting);
  section(lines, "People", briefing.peopleDueForContact);
  section(lines, "Risks", briefing.risks);
  section(lines, "Recent Completions", briefing.recentCompletions);
  section(lines, "Unresolved", briefing.unresolved);
  if (lines.length === 1) lines.push("", "No items require attention.");
  lines.push("", "Model calls: 0 | Input tokens: 0 | Output tokens: 0");
  return lines.join("\n");
}

function section(lines: string[], title: string, items: BriefingItem[]): void {
  if (items.length === 0) return;
  lines.push("", title);
  for (const item of items) lines.push(`- ${item.summary}${item.evidenceIds.length > 0 ? ` [${item.evidenceIds.join(", ")}]` : ""}`);
}

function taskItem(task: DerivedStateRecord, prefix: string): BriefingItem {
  return {
    summary: `${prefix}: ${String(task.content.description ?? task.entityId)}`,
    evidenceIds: [task.entityId!, task.stateId, String(task.content.source ?? "")].filter(Boolean),
  };
}

function attentionItems(
  ids: string[], tasks: Map<string, DerivedStateRecord>,
  findings: Map<string, Record<string, unknown>>, attentionStateId: string | undefined,
  prefix: string,
): BriefingItem[] {
  return ids.map((id) => {
    const task = tasks.get(id);
    if (task) return taskItem(task, prefix);
    const finding = findings.get(id);
    if (finding) return {
      summary: `${prefix}: ${String(finding.statement ?? id)}`,
      evidenceIds: [id, attentionStateId].filter((value): value is string => Boolean(value)),
    };
    return { summary: `${prefix}: ${id}`, evidenceIds: [id] };
  });
}

function objects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return value === undefined || value === null || value === "" ? [] : [String(value)];
}

function recentDate(value: unknown, today: string, days: number): boolean {
  if (typeof value !== "string") return false;
  const age = new Date(`${today}T00:00:00Z`).getTime() - new Date(`${value}T00:00:00Z`).getTime();
  return age >= 0 && age <= days * 24 * 60 * 60 * 1000;
}
