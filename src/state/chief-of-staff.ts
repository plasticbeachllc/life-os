import type { DerivedStateRecord, OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";
import { materializeProjection, type ProjectionBuilder } from "./projection-contract";

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
  active_attention_signals: Array<{
    attention_id: string;
    type: string;
    summary: string;
    impact: string;
    urgency: string;
    finding_ids: string[];
    presentation_channel: string;
    presentation_reason: string;
  }>;
  unresolved_ambiguities: string[];
  suggested_focus: string[];
}

interface ChiefProjectionInput {
  now: Date;
  prior?: DerivedStateRecord;
  projects: DerivedStateRecord[];
  people: DerivedStateRecord[];
  tasks: DerivedStateRecord[];
  findingAttention?: DerivedStateRecord;
  recentChanges: string[];
  unresolvedAmbiguities: string[];
}

export const chiefOfStaffBuilder: ProjectionBuilder<ChiefProjectionInput, ChiefOfStaffState> = {
  name: "chief-of-staff", version: "v6", stateType: "chief_of_staff_state",
  entityId: () => undefined,
  inputs: (input) => [
    { type: "calendar_date", id: "current", hash: localDate(input.now) },
    ...chiefDependencies(input).map((state) => ({
      type: state.stateType, id: state.entityId ?? state.stateId,
      hash: state.dependencyHash ?? sha256Value([state.stateId, state.stateVersion]),
    })),
    { type: "recent_changes", id: "current", hash: sha256Value(retainedRecentChanges(input)) },
    { type: "unresolved_ambiguities", id: "current", hash: sha256Value(input.unresolvedAmbiguities) },
  ],
  build: buildChiefContent,
};

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
  const value: ChiefProjectionInput = {
    now, ...(prior ? { prior } : {}), projects, people, tasks,
    ...(findingAttention ? { findingAttention } : {}),
    recentChanges: input.recentChanges ?? [],
    unresolvedAmbiguities: [...new Set(input.unresolvedAmbiguities ?? [])].slice(0, 20),
  };
  return materializeProjection({
    store: input.store, builder: chiefOfStaffBuilder, value, now,
  }).state;
}

function buildChiefContent(input: ChiefProjectionInput): ChiefOfStaffState {
  const openTasks = input.tasks.filter((state) => state.content.status === "open");
  const stalledProjects = input.projects.filter((state) =>
    state.content.status === "active" && array(state.content.next_actions).length === 0,
  );
  const overdue = openTasks.filter((state) => {
    const due = stringOrNull(state.content.due_date);
    return due !== null && due < localDate(input.now);
  });
  const peopleDue = input.people.filter((state) => {
    const next = stringOrNull(state.content.next_contact);
    return next !== null && next <= localDate(input.now);
  });
  const waiting = openTasks.filter((state) => state.content.waiting === true);
  const findingOpenLoops = objects(input.findingAttention?.content.open_loops);
  const findingCommitments = objects(input.findingAttention?.content.commitments);
  const attentionSignals = objects(input.findingAttention?.content.signals).slice(0, 20);
  const presentationById = new Map(objects(input.findingAttention?.content.presentation).map((decision) => [
    String(decision.attention_id ?? ""), decision,
  ]));
  const overdueFindingIds = array(input.findingAttention?.content.overdue_finding_ids).map(String);
  const priorities = input.projects
    .filter((state) => state.content.status === "active" && array(state.content.next_actions).length > 0)
    .slice(0, 5)
    .map((state) => ({
      entity_id: state.entityId!, reason: "Active project with an explicit next action.",
      evidence_ids: [state.stateId],
    }));
  return {
    as_of: input.now.toISOString(),
    current_priorities: priorities,
    active_risks: stalledProjects.length > 0 ? [{
      summary: `${stalledProjects.length} active project(s) have no explicit next action.`,
      entity_ids: stalledProjects.flatMap((state) => state.entityId ? [state.entityId] : []),
    }] : [],
    stalled_projects: stalledProjects.flatMap((state) => state.entityId ? [state.entityId] : []),
    waiting_items: waiting.map((state) => ({ task_id: state.entityId!, waiting_on: stringOrNull(state.content.waiting_on) })),
    upcoming_decisions: [],
    people_due_for_contact: peopleDue.flatMap((state) => state.entityId ? [state.entityId] : []),
    important_recent_changes: retainedRecentChanges(input),
    overdue_commitments: [
      ...overdue.flatMap((state) => state.entityId ? [state.entityId] : []),
      ...overdueFindingIds,
    ],
    active_finding_open_loops: findingOpenLoops.map((finding) => String(finding.finding_id ?? "")).filter(Boolean),
    active_finding_commitments: findingCommitments.map((finding) => String(finding.finding_id ?? "")).filter(Boolean),
    active_attention_signals: attentionSignals.map((signal) => ({
      attention_id: String(signal.attention_id ?? ""),
      type: String(signal.type ?? ""),
      summary: String(signal.summary ?? ""),
      impact: String(signal.impact ?? ""),
      urgency: String(signal.urgency ?? ""),
      finding_ids: array(signal.finding_ids).map(String),
      presentation_channel: String(presentationById.get(String(signal.attention_id ?? ""))?.channel ?? "suppress"),
      presentation_reason: String(presentationById.get(String(signal.attention_id ?? ""))?.reason ?? "low_value_no_action"),
    })).filter((signal) => signal.attention_id && signal.type && signal.summary),
    unresolved_ambiguities: input.unresolvedAmbiguities,
    suggested_focus: suggestedFocus(
      overdue.length + overdueFindingIds.length, stalledProjects.length, waiting.length,
      attentionSignals.filter((signal) => signal.type !== "commitment_at_risk").length, priorities,
    ),
  };
}

function chiefDependencies(input: ChiefProjectionInput): DerivedStateRecord[] {
  return [
    ...input.projects, ...input.people, ...input.tasks,
    ...(input.findingAttention ? [input.findingAttention] : []),
  ];
}

function retainedRecentChanges(input: ChiefProjectionInput): string[] {
  const values = input.recentChanges.length > 0
    ? input.recentChanges
    : array(input.prior?.content.important_recent_changes).map(String);
  return [...new Set(values)].slice(0, 20);
}

function suggestedFocus(
  overdue: number,
  stalled: number,
  waiting: number,
  attention: number,
  priorities: ChiefOfStaffState["current_priorities"],
): string[] {
  const result: string[] = [];
  if (overdue > 0) result.push(`Resolve ${overdue} overdue commitment(s).`);
  if (stalled > 0) result.push(`Define next actions for ${stalled} stalled project(s).`);
  if (waiting > 0) result.push(`Review ${waiting} waiting item(s).`);
  if (attention > 0) result.push(`Review ${attention} new attention signal(s).`);
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
