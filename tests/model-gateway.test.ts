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
    cache: { schemaVersion: "4", policyVersion: "policy-v1", redactionVersion: "r1", builderVersion: "b1" },
  });

  expect(await gateway.complete(input())).toEqual({ summary: "stable" });
  expect(await gateway.complete(input())).toEqual({ summary: "stable" });
  expect(adapterCalls).toBe(1);
  expect(store.countRows("model_cache")).toBe(1);
  expect(store.countRows("model_calls")).toBe(2);
  expect(store.countRows("context_manifests")).toBe(2);
  expect(store.efficiencyMetrics().cacheHits).toBe(1);
});

test("model gateway rejects invalid structured output before caching", async () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-model-invalid-")), "model.db"));
  store.migrate();
  const gateway = new ModelGateway(store, {
    complete: async () => ({ output: { wrong: true }, usage: { inputTokens: 1, outputTokens: 1 } }),
  });
  const manifest = buildContext([], {
    maxInputTokens: 10, reservedOutputTokens: 0, sourceTokens: 0, entityStateTokens: 0,
    recentChangeTokens: 0, policyTokens: 0, contingencyTokens: 0,
  });
  await expect(gateway.complete({
    workflow: "test", taskType: "test", model: "test", promptVersion: "v1",
    instructions: "Return valid output.", manifest,
    validateOutput: (output) => {
      if (!output || typeof output !== "object" || !("ok" in output)) throw new Error("invalid output");
    },
  })).rejects.toThrow("invalid output");
  expect(store.countRows("model_cache")).toBe(0);
});

test("model gateway evicts invalid cached output, audits failure, and recomputes", async () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-model-cache-invalid-")), "model.db"));
  store.migrate();
  let adapterCalls = 0;
  const gateway = new ModelGateway(store, {
    complete: async () => ({
      output: adapterCalls++ === 0 ? { wrong: true } : { ok: true },
      usage: { inputTokens: 2, outputTokens: 1 },
    }),
  });
  const request = (validate: boolean) => gateway.complete({
    workflow: "cached_validation", taskType: "test", model: "test",
    promptVersion: "v1", sourceHash: "sha256:source", instructions: "Return valid output.",
    manifest: buildContext([], {
      maxInputTokens: 10, reservedOutputTokens: 0, sourceTokens: 0, entityStateTokens: 0,
      recentChangeTokens: 0, policyTokens: 0, contingencyTokens: 0,
    }),
    cache: { schemaVersion: "1", policyVersion: "policy-v1", redactionVersion: "r1", builderVersion: "b1" },
    ...(validate ? { validateOutput: (output: unknown) => {
      if (!output || typeof output !== "object" || !("ok" in output)) throw new Error("invalid output");
    } } : {}),
  });

  expect(await request(false)).toEqual({ wrong: true });
  expect(await request(true)).toEqual({ ok: true });
  expect(adapterCalls).toBe(2);
  expect(store.countRows("model_cache")).toBe(1);
  const db = store.open();
  try {
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM model_calls WHERE status = 'failed' AND cached = 1",
    ).get()!.count).toBe(1);
  } finally {
    db.close();
  }
});
