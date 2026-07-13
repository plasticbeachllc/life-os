import { expect, test } from "bun:test";

import { buildContext } from "../src/context/builder";
import { modelCacheKey } from "../src/orchestration/cache";
import { routeModel } from "../src/orchestration/model-router";

const budget = {
  maxInputTokens: 100,
  reservedOutputTokens: 20,
  sourceTokens: 30,
  entityStateTokens: 30,
  recentChangeTokens: 20,
  policyTokens: 10,
  contingencyTokens: 10,
};

test("context builder ranks, deduplicates, and records omissions", () => {
  const manifest = buildContext([
    { id: "project", category: "entity_state", retrievalLevel: 1, content: { risk: "blocked" }, tokenEstimate: 20, relevance: 1, impact: 1, sourceRefs: ["project_1"] },
    { id: "duplicate", category: "entity_state", retrievalLevel: 1, content: { risk: "blocked" }, tokenEstimate: 20, relevance: 0.8, sourceRefs: ["project_1"] },
    { id: "large", category: "source", retrievalLevel: 3, content: "full source", tokenEstimate: 40, relevance: 0.5, sourceRefs: ["note_1"] },
  ], budget);

  expect(manifest.includedItems.map((item) => item.id)).toEqual(["project"]);
  expect(manifest.omittedItems.map((item) => item.omissionReason).sort()).toEqual(["category_budget", "duplicate"]);
  expect(manifest.retrievalLevels).toEqual([1]);
});

test("router avoids a model when deterministic resolution is available", () => {
  const route = routeModel({
    deterministicResolutionAvailable: true, ambiguity: 0, consequenceOfError: 0.2,
    contextComplexity: 0.1, requiresSynthesis: false, structuredExtraction: true,
  }, { extractionModel: "small", reasoningModel: "large" });
  expect(route.tier).toBe("none");
});

test("cache keys are stable across object construction", () => {
  const input = { workflow: "extract", promptVersion: "v1", model: "small", sourceHash: "s", contextHash: "c", schemaVersion: "2", policyVersion: "p", redactionVersion: "r1", builderVersion: "b1" };
  expect(modelCacheKey(input)).toBe(modelCacheKey({ ...input }));
  for (const field of ["workflow", "promptVersion", "model", "sourceHash", "contextHash",
    "schemaVersion", "policyVersion", "redactionVersion", "builderVersion"] as const) {
    expect(modelCacheKey({ ...input,
      [field]: `${String((input as Record<string, string>)[field] ?? "v")}-changed` }))
      .not.toBe(modelCacheKey(input));
  }
});

test("context manifests use an injected clock", () => {
  expect(buildContext([], budget, { now: new Date("2026-01-02T03:04:05.000Z") }).createdAt)
    .toBe("2026-01-02T03:04:05.000Z");
});
