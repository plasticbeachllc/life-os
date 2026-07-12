import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";

import { ObsidianVault, type VaultNote } from "../adapters/obsidian";
import { OperationalStore } from "../db/store";
import { createHealthReport, type Finding, type HealthReport, type Severity } from "../models/common";
import { loadPolicy } from "../policy/loader";
import { hasNonemptySection, markdownTasks, wikiLinks } from "../util/markdown";

const requiredFolders = [
  "00 Inbox",
  "10 Journal",
  "20 Projects",
  "30 People",
  "40 Planning",
  "90 System",
  "90 System/AI",
];

const projectStatuses = new Set(["active", "paused", "completed", "cancelled"]);
const goalStatuses = new Set(["active", "later", "completed", "abandoned"]);

export async function runDoctor(input: {
  vault: ObsidianVault;
  store: OperationalStore;
}): Promise<HealthReport> {
  const findings: Finding[] = [];

  input.vault.requireExists();
  checkRequiredFolders(input.vault, findings);
  await checkPolicy(input.vault, findings);
  checkDatabase(input.store, findings);

  const notes = await input.vault.notes();
  checkFrontmatter(notes, findings);
  checkCanonicalDuplicates(notes, findings);
  checkPeople(notes, findings);
  checkProjects(notes, findings);
  checkGoals(notes, findings);
  checkDailyNotes(notes, findings);
  checkTasks(notes, findings);
  await checkInbox(input.vault, findings);
  checkLinks(input.vault, notes, findings);

  return createHealthReport(findings);
}

function add(findings: Finding[], severity: Severity, message: string, extras: Omit<Finding, "severity" | "message"> = {}): void {
  findings.push({ severity, message, ...extras });
}

function checkRequiredFolders(vault: ObsidianVault, findings: Finding[]): void {
  const missing = requiredFolders.filter((folder) => !existsSync(vault.path(folder)));
  if (missing.length === 0) {
    add(findings, "ok", "required folders found");
    return;
  }
  for (const folder of missing) add(findings, "error", "missing required folder", { path: folder });
}

async function checkPolicy(vault: ObsidianVault, findings: Finding[]): Promise<void> {
  const policy = await loadPolicy(vault);
  for (const name of Object.keys(policy.found).sort()) {
    add(findings, "ok", `policy document found: ${name}`);
  }
  for (const [name, path] of Object.entries(policy.missing).sort()) {
    add(findings, "error", `mandatory policy document missing: ${name}`, { detail: path });
  }
  for (const error of policy.errors) add(findings, "error", "invalid machine-readable policy", { detail: error });
}

function checkDatabase(store: OperationalStore, findings: Finding[]): void {
  const version = store.getSchemaVersion();
  if (version === undefined) {
    add(findings, "error", "operational database is not migrated", { detail: store.databasePath });
  } else {
    add(findings, "ok", "operational database schema found", { detail: String(version) });
  }
}

function checkFrontmatter(notes: VaultNote[], findings: Finding[]): void {
  for (const note of notes) {
    for (const error of note.frontmatterErrors) {
      add(findings, "error", "invalid YAML frontmatter", {
        path: note.relativePath,
        detail: error,
      });
    }
  }
}

function checkCanonicalDuplicates(notes: VaultNote[], findings: Finding[]): void {
  const ids = new Map<string, string[]>();
  const names = new Map<string, string[]>();
  for (const note of notes) {
    const type = note.metadata.type;
    if (!["person", "project", "goal"].includes(String(type))) continue;

    const id = note.metadata.id;
    if (id) pushMap(ids, String(id), note.relativePath);
    pushMap(names, `${String(type)}:${note.title.toLocaleLowerCase()}`, note.relativePath);
  }

  for (const [id, paths] of ids) {
    if (paths.length > 1) add(findings, "error", "duplicate canonical id", { detail: `${id}: ${paths.join(", ")}` });
  }
  for (const [key, paths] of names) {
    if (paths.length > 1) add(findings, "error", "duplicate canonical note name", { detail: `${key}: ${paths.join(", ")}` });
  }
}

function checkPeople(notes: VaultNote[], findings: Finding[]): void {
  const people = notes.filter((note) => note.relativePath.startsWith("30 People/"));
  if (people.length === 0) {
    add(findings, "info", "no person notes found");
    return;
  }

  for (const person of people) {
    if (!person.metadata.id) add(findings, "warning", "person note missing id", { path: person.relativePath });
    if (!("last_contact" in person.metadata)) add(findings, "warning", "person note missing last_contact metadata", { path: person.relativePath });
    if (!hasNonemptySection(person.body, "Interaction log")) {
      add(findings, "info", "person note has no recorded interactions", { path: person.relativePath });
    }
  }
}

function checkProjects(notes: VaultNote[], findings: Finding[]): void {
  const projects = notes.filter((note) => note.relativePath.startsWith("20 Projects/"));
  for (const project of projects) {
    const status = String(project.metadata.status ?? "active");
    if (!projectStatuses.has(status)) add(findings, "error", "invalid project status", { path: project.relativePath, detail: status });
    if (!project.metadata.id) add(findings, "warning", "project note missing id", { path: project.relativePath });
    if (!hasNonemptySection(project.body, "Outcome")) add(findings, "warning", "project missing outcome", { path: project.relativePath });
    if (status === "active" && !hasNonemptySection(project.body, "Next actions")) {
      add(findings, "warning", "active project missing next action", { path: project.relativePath });
    }
  }
}

function checkGoals(notes: VaultNote[], findings: Finding[]): void {
  const goals = notes.filter((note) => note.relativePath.startsWith("40 Planning/") && basename(note.relativePath) !== "Goals.md" && basename(note.relativePath) !== "Commitments.md");
  for (const goal of goals) {
    const status = String(goal.metadata.status ?? "active");
    if (!goalStatuses.has(status)) add(findings, "error", "invalid goal status", { path: goal.relativePath, detail: status });
    if (!goal.metadata.id) add(findings, "warning", "goal note missing id", { path: goal.relativePath });
  }
}

function checkDailyNotes(notes: VaultNote[], findings: Finding[]): void {
  for (const note of notes.filter((item) => item.relativePath.startsWith("10 Journal/"))) {
    if (dirname(note.relativePath) === "10 Journal") {
      add(findings, "warning", "daily note is not stored under 10 Journal/YYYY", { path: note.relativePath });
    }
  }
}

function checkTasks(notes: VaultNote[], findings: Finding[]): void {
  const seen = new Map<string, string[]>();
  for (const note of notes) {
    for (const task of markdownTasks(note.raw)) {
      if (task.state.toLocaleLowerCase() === "x") continue;
      pushMap(seen, task.text.toLocaleLowerCase().replace(/\s+/g, " ").trim(), note.relativePath);
    }
  }
  for (const [text, paths] of seen) {
    if (paths.length > 1) add(findings, "warning", "possible duplicate open task", { detail: `${text}: ${paths.join(", ")}` });
  }
}

async function checkInbox(vault: ObsidianVault, findings: Finding[]): Promise<void> {
  const inboxPath = vault.path("00 Inbox/Inbox.md");
  if (!existsSync(inboxPath)) {
    add(findings, "error", "missing Inbox.md", { path: "00 Inbox/Inbox.md" });
    return;
  }
  const raw = await Bun.file(inboxPath).text();
  const unresolvedLines = raw
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"));
  add(findings, unresolvedLines.length > 25 ? "warning" : "ok", "inbox size is manageable", {
    detail: String(unresolvedLines.length),
  });
}

function checkLinks(vault: ObsidianVault, notes: VaultNote[], findings: Finding[]): void {
  for (const note of notes) {
    for (const link of wikiLinks(note.raw)) {
      if (!vault.noteExistsForLink(link)) add(findings, "warning", "broken internal link", { path: note.relativePath, detail: link });
    }
  }
}

function pushMap(map: Map<string, string[]>, key: string, value: string): void {
  const current = map.get(key) ?? [];
  current.push(value);
  map.set(key, current);
}
