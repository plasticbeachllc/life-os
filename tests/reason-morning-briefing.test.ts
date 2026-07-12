import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";
import { ModelGateway } from "../src/orchestration/model-gateway";
import { reasonAboutMorningBriefing } from "../src/workflows/reason-morning-briefing";

test("morning reasoning uses compact context and caches identical synthesis", async () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-reason-")), "store.db"));
  store.migrate();
  store.saveDerivedState({
    stateId: "state_chief", stateType: "chief_of_staff_state", stateVersion: 1,
    content: { current_priorities: [], active_risks: [], unresolved_ambiguities: [] },
    sourceHashes: ["chief-source"], generationMethod: "test", createdAt: "2026-07-12T08:00:00Z",
  });
  store.saveDerivedState({
    stateId: "state_daily", stateType: "daily_state", entityId: "2026-07-12", stateVersion: 1,
    content: { date: "2026-07-12", focus: [], recentCompletions: [] },
    sourceHashes: ["daily-source"], generationMethod: "test", createdAt: "2026-07-12T08:00:00Z",
  });
  let adapterCalls = 0;
  const gateway = new ModelGateway(store, {
    complete: async (input) => {
      adapterCalls += 1;
      expect(input.context).toHaveLength(3);
      return { output: { additions: [] }, usage: { inputTokens: 120, outputTokens: 12 } };
    },
  });
  const request = () => reasonAboutMorningBriefing({
    store, gateway, routerConfig: { extractionModel: "small", reasoningModel: "reasoning" },
    policyVersion: "policy-v1", schemaVersion: "4",
  });

  expect(await request()).toEqual({ additions: [] });
  expect(await request()).toEqual({ additions: [] });
  expect(adapterCalls).toBe(1);
  expect(store.countRows("context_manifests")).toBe(2);
  expect(store.efficiencyMetrics().cacheHits).toBe(1);
});
