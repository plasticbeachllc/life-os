import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore, type DerivedStateRecord } from "../src/db/store";
import { formatMorningBriefing, generateMorningBriefing, getMorningRecommendationOverlay, type MorningBriefing } from "../src/workflows/morning-briefing";
import { efficiencyReport } from "../src/workflows/efficiency-metrics";

function fixture(): OperationalStore {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-briefing-")), "store.db"));
  store.migrate();
  save(store, "chief_of_staff_state", undefined, 1, {
    current_priorities: [], overdue_commitments: [], waiting_items: [],
    people_due_for_contact: [], active_risks: [], unresolved_ambiguities: [],
  }, ["chief-v1"]);
  save(store, "task_state", "task_due", 1, {
    description: "Prepare briefing", status: "open", due_date: "2026-07-12",
    source: "obsidian:40 Planning/Commitments.md#L4",
  }, ["task-due-v1"]);
  save(store, "task_state", "task_done", 1, {
    description: "Test workflow", status: "completed", completed_at: "2026-07-11",
    source: "obsidian:10 Journal/2026/2026-07-11.md#L12",
  }, ["task-done-v1"]);
  return store;
}

test("morning briefing uses compact state, preserves evidence, and caches unchanged input", () => {
  const store = fixture();
  const now = new Date("2026-07-12T09:00:00Z");
  const first = generateMorningBriefing({ store, now });
  const second = generateMorningBriefing({ store, now });
  const briefing = first.state.content as unknown as MorningBriefing;

  expect(first.cached).toBe(false);
  expect(second.cached).toBe(true);
  expect(briefing.dueToday[0]?.evidenceIds).toContain("task_due");
  expect(briefing.recentCompletions[0]?.summary).toContain("Test workflow");
  expect(briefing.metrics.modelCalls).toBe(0);
  expect(formatMorningBriefing(briefing, false)).toContain("Input tokens: 0");
  expect(store.countRows("runs")).toBe(2);
  expect(store.listCurrentDerivedStates("daily_state")).toHaveLength(1);
  store.recordBriefingFeedback({
    stateId: first.state.stateId, itemKey: "dueToday:0", useful: true,
    recordedAt: "2026-07-12T10:00:00Z",
  });
  const metrics = efficiencyReport(store);
  expect(metrics.usefulBriefingItems).toBe(1);
  expect(metrics.tokensPerUsefulBriefingItem).toBe(0);
  expect(metrics.usefulOutputsPerThousandTokens).toBeNull();
});

test("changed compact dependency invalidates daily briefing cache", () => {
  const store = fixture();
  const now = new Date("2026-07-12T09:00:00Z");
  generateMorningBriefing({ store, now });
  save(store, "task_state", "task_due", 2, {
    description: "Prepare briefing", status: "completed", completed_at: "2026-07-12",
    source: "obsidian:40 Planning/Commitments.md#L4",
  }, ["task-due-v2"]);
  const changed = generateMorningBriefing({ store, now });
  expect(changed.cached).toBe(false);
  expect(changed.state.stateVersion).toBe(2);
});

test("model recommendations remain a separate optional overlay", () => {
  const store = fixture();
  const date = "2026-07-12";
  const daily = generateMorningBriefing({ store, now: new Date(`${date}T09:00:00Z`) }).state;
  save(store, "briefing_reasoning_state", date, 1, {
    recommendations: [{ summary: "Consider the plan", evidenceIds: [daily.stateId] }],
  }, [daily.dependencyHash!]);

  expect(daily.content).not.toHaveProperty("recommendations");
  expect(getMorningRecommendationOverlay(store, date)).toMatchObject({
    date, recommendations: [{ summary: "Consider the plan" }],
  });
  expect(getMorningRecommendationOverlay(store, "2026-07-13")).toBeUndefined();
});

function save(
  store: OperationalStore,
  stateType: string,
  entityId: string | undefined,
  stateVersion: number,
  content: Record<string, unknown>,
  sourceHashes: string[],
): void {
  const record: DerivedStateRecord = {
    stateId: `state_${stateType}_${entityId ?? "global"}_${stateVersion}`,
    stateType, ...(entityId ? { entityId } : {}), stateVersion, content, sourceHashes,
    generationMethod: "test", createdAt: "2026-07-12T08:00:00Z",
  };
  store.saveDerivedState(record);
}
