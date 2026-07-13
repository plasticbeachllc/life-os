import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ObsidianVault, type VaultNote } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import { rebuildFindingAttentionState } from "../src/state/finding-attention";
import { lifeOsProjectionRegistry } from "../src/state/projection-registry";
import { StateProjector } from "../src/state/projections";
import { generateMorningBriefing } from "../src/workflows/morning-briefing";
import { rebuildState } from "../src/workflows/rebuild-state";

test("projection registry exposes the coordinated builders and durable provenance", () => {
  expect(lifeOsProjectionRegistry().list()).toEqual([
    { name: "chief-of-staff", version: "v5", stateType: "chief_of_staff_state" },
    { name: "finding-attention", version: "v3", stateType: "finding_attention_state" },
    { name: "person-state", version: "v2", stateType: "person_state" },
    { name: "project-state", version: "v2", stateType: "project_state" },
    { name: "task-state", version: "v2", stateType: "task_state" },
  ]);
  const store = database("registry");
  const projector = new StateProjector(store, new Date("2026-07-12T09:00:00.000Z"));
  const first = projector.projectProject(projectNote("First outcome", "First task"));
  const unchanged = projector.projectProject(projectNote("First outcome", "First task"));

  expect(unchanged.stateId).toBe(first.stateId);
  expect(first).toMatchObject({
    builderName: "project-state", builderVersion: "v2",
    inputProvenance: [{ type: "obsidian_note", id: "20 Projects/Life OS.md" }],
  });
  expect(first.dependencyHash).toMatch(/^sha256:/);
  expect(store.countRows("derived_states")).toBe(1);
});

test("full rebuild retires removed projections and never rewrites journal prose", async () => {
  const root = mkdtempSync(join(tmpdir(), "life-os-projection-retire-"));
  const projectPath = join(root, "20 Projects/Life OS.md");
  const journalPath = join(root, "10 Journal/2026/2026-07-12.md");
  write(projectPath, projectMarkdown("Outcome", "Task"));
  const journal = "# Journal\n\nHuman-authored reflection stays exactly as written.\n";
  write(journalPath, journal);
  const store = database("retire");
  const now = new Date("2026-07-12T09:00:00.000Z");

  await rebuildState({ vault: new ObsidianVault(root), store, now });
  expect(store.listCurrentDerivedStates("project_state")).toHaveLength(1);
  expect(store.listCurrentDerivedStates("task_state")).toHaveLength(1);
  write(projectPath, projectMarkdown("Outcome", "").replace(
    /\n## Next actions\n- \[ \].*\n  <!-- life-os:task_id=task_one -->\n/,
    "\n## Next actions\n",
  ));
  const taskRemoved = await rebuildState({ vault: new ObsidianVault(root), store, now });
  expect(taskRemoved.retired).toBe(1);
  expect(store.listCurrentDerivedStates("project_state")).toHaveLength(1);
  expect(store.listCurrentDerivedStates("task_state")).toHaveLength(0);
  rmSync(projectPath);
  const removed = await rebuildState({ vault: new ObsidianVault(root), store, now });

  expect(removed.retired).toBe(1);
  expect(store.listCurrentDerivedStates("project_state")).toHaveLength(0);
  expect(store.listCurrentDerivedStates("task_state")).toHaveLength(0);
  expect(readFileSync(journalPath, "utf8")).toBe(journal);
});

test("targeted rebuild converges with a full rebuild without storage churn", async () => {
  const root = mkdtempSync(join(tmpdir(), "life-os-projection-target-"));
  const projectPath = join(root, "20 Projects/Life OS.md");
  write(projectPath, projectMarkdown("First outcome", "First task"));
  write(join(root, "30 People/Ada.md"), `---\ntype: person\nid: person_ada\n---\n# Ada\n`);
  const store = database("target");
  const vault = new ObsidianVault(root);
  const now = new Date("2026-07-12T09:00:00.000Z");
  await rebuildState({ vault, store, now });

  write(projectPath, projectMarkdown("Changed outcome", "Changed task"));
  await rebuildState({
    vault, store, now,
    targets: [
      { stateType: "project_state", entityId: "project_life_os" },
      { stateType: "task_state", entityId: "task_one" },
    ],
  });
  const beforeFull = store.countRows("derived_states");
  const projectedIds = [
    store.getCurrentDerivedState("project_state", "project_life_os")?.stateId,
    store.getCurrentDerivedState("task_state", "task_one")?.stateId,
    store.getCurrentDerivedState("chief_of_staff_state")?.stateId,
  ];
  const full = await rebuildState({ vault, store, now });

  expect(full.projected).toBe(0);
  expect(store.countRows("derived_states")).toBe(beforeFull);
  expect([
    store.getCurrentDerivedState("project_state", "project_life_os")?.stateId,
    store.getCurrentDerivedState("task_state", "task_one")?.stateId,
    store.getCurrentDerivedState("chief_of_staff_state")?.stateId,
  ]).toEqual(projectedIds);
  const daily = generateMorningBriefing({ store, now });
  for (const registration of lifeOsProjectionRegistry().list()) {
    const states = store.listCurrentDerivedStates(registration.stateType);
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state.builderName).toBe(registration.name);
      expect(state.builderVersion).toBe(registration.version);
      expect(state.dependencyHash).toMatch(/^sha256:/);
      expect(state.inputProvenance?.length).toBeGreaterThan(0);
    }
  }
  expect(daily.state.builderName).toBe("morning-briefing");
  expect(daily.state.builderVersion).toBe("v4");
  expect(daily.state.inputProvenance?.length).toBeGreaterThan(0);
  expect(store.countRows("model_calls")).toBe(0);
});

test("time-sensitive projections invalidate on date rollover, not clock movement", () => {
  const store = database("date");
  const first = rebuildFindingAttentionState({ store, now: new Date("2026-07-12T08:00:00.000Z") });
  const sameDate = rebuildFindingAttentionState({ store, now: new Date("2026-07-12T18:00:00.000Z") });
  const nextDate = rebuildFindingAttentionState({ store, now: new Date("2026-07-13T08:00:00.000Z") });

  expect(sameDate.stateId).toBe(first.stateId);
  expect(nextDate.stateVersion).toBe(2);
  expect(nextDate.inputProvenance).toContainEqual({
    type: "calendar_date", id: "current", hash: "2026-07-13",
  });
});

function database(name: string): OperationalStore {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), `life-os-${name}-`)), "state.db"));
  store.migrate();
  return store;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function projectMarkdown(outcome: string, task: string): string {
  return `---\ntype: project\nid: project_life_os\nstatus: active\n---\n# Life OS\n\n## Outcome\n${outcome}\n\n## Next actions\n- [ ] ${task}\n  <!-- life-os:task_id=task_one -->\n`;
}

function projectNote(outcome: string, task: string): VaultNote {
  const raw = projectMarkdown(outcome, task);
  return {
    path: "/vault/20 Projects/Life OS.md", relativePath: "20 Projects/Life OS.md",
    metadata: { type: "project", id: "project_life_os", status: "active" },
    body: raw, raw, frontmatterErrors: [], title: "Life OS",
  };
}
