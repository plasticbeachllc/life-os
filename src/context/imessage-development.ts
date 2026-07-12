import type { DerivedStateRecord, OperationalStore } from "../db/store";
import type { ContextCandidate } from "./builder";
import { SubjectLinkStore } from "./subject-links";

export function imessageDevelopmentContextCandidates(input: {
  store: OperationalStore;
  sourceId: string;
  conversationId: string;
}): ContextCandidate[] {
  const people = new SubjectLinkStore(input.store).linkedPeopleForIMessageConversation(input);
  if (people.length === 0) return [];

  const candidates: ContextCandidate[] = [];
  const personIds = new Set(people.flatMap((person) => person.entityId ? [person.entityId] : []));
  for (const person of people) candidates.push(personCandidate(person));

  for (const task of input.store.listCurrentDerivedStates("task_state")) {
    if (task.content.status !== "open" || !personIds.has(String(task.content.person_id ?? ""))) continue;
    candidates.push(taskCandidate(task));
  }

  const names = people.flatMap(personNames);
  for (const calendar of input.store.listCurrentDerivedStates("calendar_state")) {
    const events = array(calendar.content.next_events).filter((event) => eventMatchesNames(event, names));
    if (events.length > 0) candidates.push(calendarCandidate(calendar, events));
  }
  return candidates;
}

function personCandidate(state: DerivedStateRecord): ContextCandidate {
  const content = {
    context_kind: "linked_person",
    evidence_id: stateEvidenceId(state),
    state_id: state.stateId,
    state_type: state.stateType,
    entity_id: state.entityId,
    person: {
      display_name: state.content.display_name,
      aliases: array(state.content.aliases).map(String),
      last_contact: state.content.last_contact ?? null,
      next_contact: state.content.next_contact ?? null,
      open_loop_count: state.content.open_loop_count ?? 0,
      recent_interaction_summary: state.content.recent_interaction_summary ?? null,
      active_project_ids: array(state.content.active_project_ids).map(String),
    },
  };
  return {
    id: `person-context:${state.entityId}`,
    category: "entity_state",
    retrievalLevel: 1,
    content,
    tokenEstimate: estimate(content),
    relevance: 0.9,
    impact: 0.8,
    recency: 0.7,
    sourceRefs: [state.stateId, ...state.sourceHashes],
  };
}

function taskCandidate(state: DerivedStateRecord): ContextCandidate {
  const content = {
    context_kind: "person_open_loop",
    evidence_id: stateEvidenceId(state),
    state_id: state.stateId,
    state_type: state.stateType,
    entity_id: state.entityId,
    open_loop: {
      task_id: state.content.task_id,
      description: state.content.description,
      due_date: state.content.due_date ?? null,
      scheduled_date: state.content.scheduled_date ?? null,
      waiting: state.content.waiting === true,
      project_id: state.content.project_id ?? null,
    },
  };
  return {
    id: `open-loop-context:${state.entityId}`,
    category: "entity_state",
    retrievalLevel: 1,
    content,
    tokenEstimate: estimate(content),
    relevance: 0.85,
    impact: 0.9,
    recency: 0.7,
    sourceRefs: [state.stateId, ...state.sourceHashes],
  };
}

function calendarCandidate(state: DerivedStateRecord, events: unknown[]): ContextCandidate {
  const content = {
    context_kind: "related_calendar",
    evidence_id: stateEvidenceId(state),
    state_id: state.stateId,
    state_type: state.stateType,
    entity_id: state.entityId,
    related_events: events.slice(0, 5),
  };
  return {
    id: `calendar-context:${state.entityId ?? state.stateId}`,
    category: "entity_state",
    retrievalLevel: 1,
    content,
    tokenEstimate: estimate(content),
    relevance: 0.75,
    impact: 0.8,
    recency: 0.9,
    sourceRefs: [state.stateId, ...state.sourceHashes],
  };
}

function stateEvidenceId(state: DerivedStateRecord): string {
  return `state:${state.stateId}`;
}

function personNames(state: DerivedStateRecord): string[] {
  return [state.content.display_name, ...array(state.content.aliases)]
    .filter((value): value is string => typeof value === "string" && value.trim().length >= 3)
    .map((value) => value.trim().toLocaleLowerCase());
}

function eventMatchesNames(value: unknown, names: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const searchable = [record.summary, record.location]
    .filter((item): item is string => typeof item === "string")
    .join(" ").toLocaleLowerCase();
  return names.some((name) => new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}($|[^\\p{L}\\p{N}])`, "u",
  ).test(searchable));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function estimate(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
