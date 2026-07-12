import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildContext } from "../src/context/builder";
import { OperationalStore } from "../src/db/store";
import { ModelGateway } from "../src/orchestration/model-gateway";

test("model gateway records context and token instrumentation", async () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-model-")), "model.db"));
  store.migrate();
  const manifest = buildContext([
    { id: "state", category: "entity_state", retrievalLevel: 1, content: { status: "active" }, tokenEstimate: 10, relevance: 1, sourceRefs: ["project_1"] },
  ], { maxInputTokens: 50, reservedOutputTokens: 10, sourceTokens: 10, entityStateTokens: 20, recentChangeTokens: 5, policyTokens: 5, contingencyTokens: 10 });
  const gateway = new ModelGateway(store, {
    complete: async () => ({ output: { recommendation: "focus" }, usage: { inputTokens: 12, outputTokens: 3, estimatedCost: 0.001 } }),
  });

  expect(await gateway.complete({
    workflow: "morning_briefing", taskType: "synthesis", model: "reasoning",
    promptVersion: "v1", instructions: "Prioritize current changes.", manifest,
  })).toEqual({ recommendation: "focus" });
  expect(store.countRows("model_calls")).toBe(1);
  expect(store.countRows("context_manifests")).toBe(1);
});

test("model gateway caches versioned intermediate output and audits cache hits", async () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-model-cache-")), "model.db"));
  store.migrate();
  let adapterCalls = 0;
  const gateway = new ModelGateway(store, {
    complete: async () => {
      adapterCalls += 1;
      return { output: { summary: "stable" }, usage: { inputTokens: 20, outputTokens: 5 } };
    },
  });
  const input = () => ({
    workflow: "project_summary", taskType: "summary", model: "small",
    promptVersion: "v1", sourceHash: "sha256:source", instructions: "Summarize.",
    manifest: buildContext([
      { id: "project", category: "entity_state" as const, retrievalLevel: 1 as const, content: { status: "active" }, tokenEstimate: 10, relevance: 1, sourceRefs: ["project_1"] },
    ], { maxInputTokens: 50, reservedOutputTokens: 10, sourceTokens: 5, entityStateTokens: 20, recentChangeTokens: 5, policyTokens: 5, contingencyTokens: 5 }),
    cache: { schemaVersion: "4", policyVersion: "policy-v1" },
  });

  expect(await gateway.complete(input())).toEqual({ summary: "stable" });
  expect(await gateway.complete(input())).toEqual({ summary: "stable" });
  expect(adapterCalls).toBe(1);
  expect(store.countRows("model_cache")).toBe(1);
  expect(store.countRows("model_calls")).toBe(2);
  expect(store.countRows("context_manifests")).toBe(2);
  expect(store.efficiencyMetrics().cacheHits).toBe(1);
});
