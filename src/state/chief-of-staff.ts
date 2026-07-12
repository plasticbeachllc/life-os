import type { DerivedStateRecord, OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";
import { newId } from "../util/ids";

export interface ChiefOfStaffState {
  as_of: string;
  current_priorities: Array<{ entity_id: string; reason: string; evidence_ids: string[] }>;
  active_risks: Array<{ summary: string; entity_ids: string[] }>;
  stalled_projects: string[];
  waiting_items: Array<{ task_id: string; waiting_on: string | null }>;
  upcoming_decisions: Array<{ entity_id: string; summary: string }>;
  people_due_for_contact: string[];
  important_recent_changes: string[];
  overdue_commitments: string[];
  active_finding_open_loops: string[];
  active_finding_commitments: string[];
  unresolved_ambiguities: string[];
  suggested_focus: string[];
}

export function rebuildChiefOfStaffState(input: {
  store: OperationalStore;
  now?: Date;
  recentChanges?: string[];
  unresolvedAmbiguities?: string[];
}): DerivedStateRecord {
  const now = input.now ?? new Date();
  const prior = input.store.getCurrentDerivedState("chief_of_staff_state");
  const projects = input.store.listCurrentDerivedStates("project_state");
  const people = input.store.listCurrentDerivedStates("person_state");
  const tasks = input.store.listCurrentDerivedStates("task_state");
  const findingAttention = input.store.getCurrentDerivedState("finding_attention_state");
  const openTasks = tasks.filter((state) => state.content.status === "open");
  const stalledProjects = projects.filter((state) =>
    state.content.status === "active" && array(state.content.next_actions).length === 0,
  );
  const overdue = openTasks.filter((state) => {
    const due = stringOrNull(state.content.due_date);
    return due !== null && due < localDate(now);
  });
  const peopleDue = people.filter((state) => {
    const next = stringOrNull(state.content.next_contact);
    return next !== null && next <= localDate(now);
  });
  const waiting = openTasks.filter((state) => state.content.waiting === true);
  const findingOpenLoops = objects(findingAttention?.content.open_loops);
  const findingCommitments = objects(findingAttention?.content.commitments);
  const overdueFindingIds = array(findingAttention?.content.overdue_finding_ids).map(String);
  const priorities = projects
    .filter((state) => state.content.status === "active" && array(state.content.next_actions).length > 0)
    .slice(0, 5)
    .map((state) => ({
      entity_id: state.entityId!, reason: "Active project with an explicit next action.",
      evidence_ids: [state.stateId],
    }));
  const unresolvedAmbiguities = [...new Set(input.unresolvedAmbiguities ?? [])].slice(0, 20);
  const retainedRecentChanges = input.recentChanges && input.recentChanges.length > 0
    ? input.recentChanges
    : array(prior?.content.important_recent_changes).map(String);
  const content: ChiefOfStaffState = {
    as_of: now.toISOString(),
    current_priorities: priorities,
    active_risks: stalledProjects.length > 0 ? [{
      summary: `${stalledProjects.length} active project(s) have no explicit next action.`,
      entity_ids: stalledProjects.flatMap((state) => state.entityId ? [state.entityId] : []),
    }] : [],
    stalled_projects: stalledProjects.flatMap((state) => state.entityId ? [state.entityId] : []),
    waiting_items: waiting.map((state) => ({ task_id: state.entityId!, waiting_on: stringOrNull(state.content.waiting_on) })),
    upcoming_decisions: [],
    people_due_for_contact: peopleDue.flatMap((state) => state.entityId ? [state.entityId] : []),
    important_recent_changes: [...new Set(retainedRecentChanges)].slice(0, 20),
    overdue_commitments: [
      ...overdue.flatMap((state) => state.entityId ? [state.entityId] : []),
      ...overdueFindingIds,
    ],
    active_finding_open_loops: findingOpenLoops.map((finding) => String(finding.finding_id ?? "")).filter(Boolean),
    active_finding_commitments: findingCommitments.map((finding) => String(finding.finding_id ?? "")).filter(Boolean),
    unresolved_ambiguities: unresolvedAmbiguities,
    suggested_focus: suggestedFocus(
      overdue.length + overdueFindingIds.length, stalledProjects.length, waiting.length, priorities,
    ),
  };
  const dependencies = [
    ...projects, ...people, ...tasks, ...(findingAttention ? [findingAttention] : []),
  ];
  const sourceHashes = [...new Set(dependencies.flatMap((state) => state.sourceHashes))].sort();
  const dependencyHash = sha256Value({
    generatorVersion: "deterministic-chief-of-staff-v3",
    states: dependencies.map((state) => [state.stateId, state.stateVersion]),
    recentChanges: content.important_recent_changes,
    unresolvedAmbiguities,
    date: localDate(now),
  });
  if (prior?.sourceHashes.includes(dependencyHash)) return prior;
  const record: DerivedStateRecord = {
    stateId: newId("state"), stateType: "chief_of_staff_state",
    stateVersion: (prior?.stateVersion ?? 0) + 1,
    content: content as unknown as Record<string, unknown>,
    sourceHashes: [dependencyHash, ...sourceHashes],
    generationMethod: "deterministic-chief-of-staff-v3", createdAt: now.toISOString(),
  };
  input.store.saveDerivedState(record);
  return record;
}

function suggestedFocus(
  overdue: number,
  stalled: number,
  waiting: number,
  priorities: ChiefOfStaffState["current_priorities"],
): string[] {
  const result: string[] = [];
  if (overdue > 0) result.push(`Resolve ${overdue} overdue commitment(s).`);
  if (stalled > 0) result.push(`Define next actions for ${stalled} stalled project(s).`);
  if (waiting > 0) result.push(`Review ${waiting} waiting item(s).`);
  if (result.length === 0 && priorities.length > 0) result.push("Advance the highest-priority active project.");
  return result;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objects(value: unknown): Array<Record<string, unknown>> {
  return array(value).filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === "object");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function localDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
