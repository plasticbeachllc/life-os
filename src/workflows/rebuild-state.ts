import type { ObsidianVault, VaultNote } from "../adapters/obsidian";
import type { OperationalStore } from "../db/store";
import { ChangeTracker } from "../state/change-tracker";
import { StateProjector } from "../state/projections";
import { rebuildChiefOfStaffState } from "../state/chief-of-staff";
import { markdownTasks, sectionBody, type MarkdownTask } from "../util/markdown";
import { backfillExtractionFindings } from "../findings/projector";
import { rebuildFindingAttentionState } from "../state/finding-attention";
import { targetIncludes, type ProjectionTarget } from "../state/projection-contract";

export interface StateRebuildIssue {
  path: string;
  message: string;
}

export interface StateRebuildReport {
  scanned: number;
  changed: number;
  unchanged: number;
  projected: number;
  projects: number;
  people: number;
  tasks: number;
  taskCandidates: number;
  findingExtractions: number;
  findingsCreated: number;
  findingsUnchanged: number;
  retired: number;
  findingAttentionStateVersion: number;
  chiefOfStaffStateVersion: number;
  issues: StateRebuildIssue[];
}

export async function rebuildState(input: {
  vault: ObsidianVault;
  store: OperationalStore;
  targets?: ProjectionTarget[];
  now?: Date;
}): Promise<StateRebuildReport> {
  input.vault.requireExists();
  input.store.migrate();
  const tracker = new ChangeTracker(input.store);
  const now = input.now ?? new Date();
  const projector = new StateProjector(input.store, now);
  const allNotes = await input.vault.notes();
  const notes = allNotes.filter(isStateCandidate);
  const report: StateRebuildReport = {
    scanned: notes.length, changed: 0, unchanged: 0, projected: 0,
    projects: 0, people: 0, tasks: 0, taskCandidates: 0,
    findingExtractions: 0, findingsCreated: 0, findingsUnchanged: 0,
    retired: 0,
    findingAttentionStateVersion: 0,
    chiefOfStaffStateVersion: 0, issues: [],
  };
  const recentChanges: string[] = [];
  const findingBackfill = backfillExtractionFindings(input.store);
  report.findingExtractions = findingBackfill.extractions;
  report.findingsCreated = findingBackfill.created;
  report.findingsUnchanged = findingBackfill.unchanged;
  const liveProjectIds = new Set<string>();
  const livePersonIds = new Set<string>();

  for (const note of notes) {
    const expectedType = note.relativePath.startsWith("20 Projects/") ? "project" : "person";
    const validationError = validateCanonicalNote(note, expectedType);
    if (validationError) {
      report.issues.push({ path: note.relativePath, message: validationError });
      continue;
    }

    const change = tracker.track({
      sourceType: expectedType,
      sourceId: String(note.metadata.id),
      content: note.raw,
      relevantSections: relevantSections(note, expectedType),
    });
    if (change.changed) report.changed += 1;
    else report.unchanged += 1;
    const entityId = String(note.metadata.id);
    if (expectedType === "project") liveProjectIds.add(entityId);
    else livePersonIds.add(entityId);
    const stateType = expectedType === "project" ? "project_state" : "person_state";
    if (!targetIncludes(input.targets, stateType, entityId)) continue;
    const prior = input.store.getCurrentDerivedState(stateType, entityId);
    if (expectedType === "project") {
      const state = projector.projectProject(note);
      if (!prior || prior.stateId !== state.stateId) {
        report.projects += 1;
        recentChanges.push(`Project state changed: ${entityId}`);
      }
    } else {
      const state = projector.projectPerson(note);
      if (!prior || prior.stateId !== state.stateId) {
        report.people += 1;
        recentChanges.push(`Person state changed: ${entityId}`);
      }
    }
    if (!prior || input.store.getCurrentDerivedState(stateType, entityId)?.stateId !== prior.stateId) report.projected += 1;
  }

  const taskEntries = allNotes.flatMap((note) => markdownTasks(note.raw).map((task) => ({ note, task })));
  report.taskCandidates = taskEntries.length;
  const taskIdCounts = new Map<string, number>();
  for (const { task } of taskEntries) {
    if (task.taskId) taskIdCounts.set(task.taskId, (taskIdCounts.get(task.taskId) ?? 0) + 1);
  }
  for (const { note, task } of taskEntries) {
    const issue = taskValidationIssue(note, task, taskIdCounts);
    if (issue) {
      report.issues.push({ path: `${note.relativePath}:${task.line}`, message: issue });
      continue;
    }
    const taskId = task.taskId!;
    if (!targetIncludes(input.targets, "task_state", taskId)) continue;
    const prior = input.store.getCurrentDerivedState("task_state", taskId);
    const state = projector.projectTask(note, task);
    if (!prior || prior.stateId !== state.stateId) {
      report.tasks += 1;
      report.projected += 1;
      recentChanges.push(`Task state changed: ${taskId}`);
    }
  }

  if (!input.targets || input.targets.length === 0) {
    report.retired += input.store.retireDerivedStates({
      stateType: "project_state", keepEntityIds: [...liveProjectIds], retiredAt: now.toISOString(),
    });
    report.retired += input.store.retireDerivedStates({
      stateType: "person_state", keepEntityIds: [...livePersonIds], retiredAt: now.toISOString(),
    });
    report.retired += input.store.retireDerivedStates({
      stateType: "task_state",
      keepEntityIds: taskEntries.flatMap(({ note, task }) =>
        taskValidationIssue(note, task, taskIdCounts) || !task.taskId ? [] : [task.taskId]),
      retiredAt: now.toISOString(),
    });
  } else {
    const liveIds: Record<string, Set<string>> = {
      project_state: liveProjectIds,
      person_state: livePersonIds,
      task_state: new Set(taskEntries.flatMap(({ note, task }) =>
        taskValidationIssue(note, task, taskIdCounts) || !task.taskId ? [] : [task.taskId])),
    };
    for (const target of input.targets) {
      const live = liveIds[target.stateType];
      if (!target.entityId || !live || live.has(target.entityId)) continue;
      if (input.store.retireDerivedState({
        stateType: target.stateType, entityId: target.entityId, retiredAt: now.toISOString(),
      })) report.retired += 1;
    }
  }

  const findingAttention = rebuildFindingAttentionState({ store: input.store, now });
  report.findingAttentionStateVersion = findingAttention.stateVersion;
  const chiefState = rebuildChiefOfStaffState({
    store: input.store, recentChanges, now,
    unresolvedAmbiguities: report.issues.map((issue) => `${issue.path}: ${issue.message}`),
  });
  report.chiefOfStaffStateVersion = chiefState.stateVersion;

  return report;
}

function taskValidationIssue(note: VaultNote, task: MarkdownTask, counts: Map<string, number>): string | undefined {
  if (!task.taskId) return "stable task ID required";
  if ((counts.get(task.taskId) ?? 0) > 1) return `duplicate task ID: ${task.taskId}`;
  if (!/^task_[A-Za-z0-9]+$/.test(task.taskId)) return "invalid task ID";
  if (!note.relativePath.endsWith(".md")) return "canonical task source must be Markdown";
  return undefined;
}

function isStateCandidate(note: VaultNote): boolean {
  return note.relativePath.startsWith("20 Projects/") || note.relativePath.startsWith("30 People/");
}

function validateCanonicalNote(note: VaultNote, expectedType: "project" | "person"): string | undefined {
  if (note.frontmatterErrors.length > 0) return `invalid frontmatter: ${note.frontmatterErrors.join("; ")}`;
  if (note.metadata.type !== expectedType) return `expected type: ${expectedType}`;
  if (!note.metadata.id) return "canonical entity id required";
  return undefined;
}

function relevantSections(note: VaultNote, type: "project" | "person"): Record<string, string> {
  const names = type === "project"
    ? ["Outcome", "Next actions", "Risks", "Decisions"]
    : ["Context", "Interaction log", "Open loops"];
  return Object.fromEntries(
    names.flatMap((name) => {
      const content = sectionBody(note.body, name);
      return content === undefined ? [] : [[name, content]];
    }),
  );
}
