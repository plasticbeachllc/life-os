import type { VaultNote } from "../adapters/obsidian";
import type { DerivedStateRecord, OperationalStore } from "../db/store";
import { sha256Text, sha256Value } from "../util/hashing";
import { markdownTasks, sectionBody, type MarkdownTask } from "../util/markdown";
import { materializeProjection, type ProjectionBuilder } from "./projection-contract";

export interface ProjectState {
  entity_id: string;
  name: string;
  status: string;
  outcome: string | null;
  next_actions: string[];
  open_loop_count: number;
  risk_summary: string | null;
  last_meaningful_change: string | null;
  source_hashes: string[];
  state_version: number;
}

export interface PersonState {
  entity_id: string;
  display_name: string;
  aliases: string[];
  emails: string[];
  last_contact: string | null;
  next_contact: string | null;
  open_loop_count: number;
  recent_interaction_summary: string | null;
  active_project_ids: string[];
  source_hashes: string[];
  state_version: number;
}

export interface TaskState {
  task_id: string;
  description: string;
  canonical_note: string;
  source: string;
  owner: "user" | "other";
  status: "open" | "completed";
  waiting: boolean;
  project_id: string | null;
  person_id: string | null;
  due_date: string | null;
  scheduled_date: string | null;
  completed_at: string | null;
  source_hashes: string[];
  state_version: number;
}

export const projectStateBuilder: ProjectionBuilder<VaultNote, ProjectState> = {
  name: "project-state", version: "v2", stateType: "project_state",
  entityId: requireEntityId,
  inputs: (note) => [{ type: "obsidian_note", id: note.relativePath, hash: sha256Text(note.raw) }],
  build: (note) => {
    requireType(note, "project");
    const sourceHash = sha256Text(note.raw);
    const openTasks = markdownTasks(note.raw).filter((task) => task.state.toLowerCase() !== "x");
    return {
      entity_id: requireEntityId(note), name: note.title,
      status: String(note.metadata.status ?? "active"),
      outcome: sectionBody(note.body, "Outcome") ?? null,
      next_actions: openTasks.map((task) => task.text), open_loop_count: openTasks.length,
      risk_summary: sectionBody(note.body, "Risks") ?? null,
      last_meaningful_change: metadataString(note, "last_meaningful_change"),
      source_hashes: [sourceHash], state_version: 0,
    };
  },
};

export const personStateBuilder: ProjectionBuilder<VaultNote, PersonState> = {
  name: "person-state", version: "v2", stateType: "person_state",
  entityId: requireEntityId,
  inputs: (note) => [{ type: "obsidian_note", id: note.relativePath, hash: sha256Text(note.raw) }],
  build: (note) => {
    requireType(note, "person");
    const sourceHash = sha256Text(note.raw);
    const openTasks = markdownTasks(note.raw).filter((task) => task.state.toLowerCase() !== "x");
    const interactionLog = sectionBody(note.body, "Interaction log");
    return {
      entity_id: requireEntityId(note), display_name: note.title,
      aliases: metadataList(note, "aliases"), emails: metadataList(note, "emails"),
      last_contact: metadataString(note, "last_contact"), next_contact: metadataString(note, "next_contact"),
      open_loop_count: openTasks.length,
      recent_interaction_summary: interactionLog ? tail(interactionLog, 800) : null,
      active_project_ids: metadataList(note, "active_project_ids"),
      source_hashes: [sourceHash], state_version: 0,
    };
  },
};

interface TaskProjectionInput { note: VaultNote; task: MarkdownTask }

export const taskStateBuilder: ProjectionBuilder<TaskProjectionInput, TaskState> = {
  name: "task-state", version: "v2", stateType: "task_state",
  entityId: ({ task }) => task.taskId,
  inputs: ({ note, task }) => [{
    type: "obsidian_task", id: task.taskId ?? `${note.relativePath}:${task.line}`,
    hash: taskProjectionHash(note, task),
  }],
  build: ({ note, task }) => {
    if (!task.taskId) throw new Error(`stable task id required: ${note.relativePath}:${task.line}`);
    const sourceHash = taskProjectionHash(note, task);
    const canonicalEntityId = metadataString(note, "id");
    return {
      task_id: task.taskId, description: cleanTaskDescription(task.text), canonical_note: note.relativePath,
      source: task.source ?? `obsidian:${note.relativePath}#L${task.line}`,
      owner: task.text.includes("#waiting") ? "other" : "user",
      status: task.state.toLowerCase() === "x" ? "completed" : "open",
      waiting: task.text.includes("#waiting"),
      project_id: note.metadata.type === "project" ? canonicalEntityId : null,
      person_id: note.metadata.type === "person" ? canonicalEntityId : null,
      due_date: markerDate(task.text, "\\u{1F4C5}"), scheduled_date: markerDate(task.text, "\\u{23F3}"),
      completed_at: markerDate(task.text, "\\u{2705}"), source_hashes: [sourceHash], state_version: 0,
    };
  },
};

function taskProjectionHash(note: VaultNote, task: MarkdownTask): string {
  return sha256Value({
    note: note.relativePath, noteType: note.metadata.type ?? null,
    canonicalEntityId: metadataString(note, "id"), task,
  });
}

export class StateProjector {
  constructor(private readonly store: OperationalStore, private readonly now = new Date()) {}

  projectProject(note: VaultNote): DerivedStateRecord {
    const result = materializeProjection({ store: this.store, builder: projectStateBuilder, value: note, now: this.now });
    return result.state;
  }

  projectPerson(note: VaultNote): DerivedStateRecord {
    const result = materializeProjection({ store: this.store, builder: personStateBuilder, value: note, now: this.now });
    return result.state;
  }

  projectTask(note: VaultNote, task: MarkdownTask): DerivedStateRecord {
    const result = materializeProjection({ store: this.store, builder: taskStateBuilder, value: { note, task }, now: this.now });
    return result.state;
  }
}

function markerDate(text: string, escapedMarker: string): string | null {
  return text.match(new RegExp(`${escapedMarker}\\s*(\\d{4}-\\d{2}-\\d{2})`, "u"))?.[1] ?? null;
}

function cleanTaskDescription(text: string): string {
  return text
    .replace(/[\u{1F4C5}\u{23F3}\u{2705}]\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/\s+#waiting\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function requireType(note: VaultNote, expected: string): void {
  if (note.metadata.type !== expected) throw new Error(`expected ${expected} note: ${note.relativePath}`);
}

function requireEntityId(note: VaultNote): string {
  const id = metadataString(note, "id");
  if (!id) throw new Error(`canonical entity id required: ${note.relativePath}`);
  return id;
}

function metadataString(note: VaultNote, key: string): string | null {
  const value = note.metadata[key];
  return value === undefined || value === null || value === "" ? null : String(value);
}

function metadataList(note: VaultNote, key: string): string[] {
  const value = note.metadata[key];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  return String(value).replace(/^\[|\]$/g, "").split(",").map((item) => item.trim()).filter(Boolean);
}

function tail(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return value.slice(value.length - maxCharacters);
}

export function stateContentHash(state: DerivedStateRecord): string {
  return sha256Value(state.content);
}
