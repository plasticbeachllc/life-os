import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildContext } from "../src/context/builder";
import { persistableContextManifest } from "../src/context/manifests";
import { OperationalStore } from "../src/db/store";
import {
  completeReasoningCall, failReasoningCall, prepareReasoningCall, requirePreparedReasoningCall,
} from "../src/orchestration/prepared-reasoning";

test("prepared reasoning records a sanitized audit manifest and completes exact usage", () => {
  const store = testStore();
  const manifest = buildContext([{
    id: "source", category: "source", retrievalLevel: 2,
    content: { evidence_id: "source_1", private_text: "transient private text" },
    tokenEstimate: 10, relevance: 1, sourceRefs: ["source_1"],
  }], {
    maxInputTokens: 100, reservedOutputTokens: 20, sourceTokens: 30,
    entityStateTokens: 20, recentChangeTokens: 10, policyTokens: 10, contingencyTokens: 10,
  });
  const audit = persistableContextManifest(manifest, (items) => items.map((item) => ({
    ...item, content: { evidence_id: "source_1", private_text_removed: true },
  })));
  const call = prepareReasoningCall({
    store,
    identity: {
      workflow: "test_extraction", taskType: "subscription_test",
      model: "subscription-agent", promptVersion: "test-v1", sourceHash: "sha256:source",
    },
    manifest,
    auditManifest: audit,
    now: new Date("2026-07-12T12:00:00.000Z"),
  });
  const prepared = requirePreparedReasoningCall({
    store, callId: call.callId, workflow: "test_extraction", taskType: "subscription_test",
    notFoundMessage: "prepared test call not found",
    now: new Date("2026-07-12T12:01:00.000Z"),
  });
  expect(JSON.stringify(prepared.manifest.includedItems)).not.toContain("transient private text");
  expect(prepared.manifest.contextHash).toBe(manifest.contextHash);
  expect(() => requirePreparedReasoningCall({
    store, callId: call.callId, workflow: "other_workflow", taskType: "subscription_test",
    notFoundMessage: "prepared test call not found",
    now: new Date("2026-07-12T12:01:00.000Z"),
  })).toThrow("prepared test call not found");

  const completed = completeReasoningCall({
    store, call,
    usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 5 },
    now: new Date("2026-07-12T12:01:00.000Z"),
  });
  expect(completed).toMatchObject({
    status: "completed", inputTokens: 120, outputTokens: 30, cachedTokens: 5,
    completedAt: "2026-07-12T12:01:00.000Z",
  });
  expect(() => requirePreparedReasoningCall({
    store, callId: call.callId, workflow: "test_extraction", taskType: "subscription_test",
    notFoundMessage: "prepared test call not found",
  })).toThrow("prepared test call not found");
});

test("prepared reasoning expires by injected clock and records only categorized failures", () => {
  const store = testStore();
  const manifest = buildContext([], {
    maxInputTokens: 50, reservedOutputTokens: 10, sourceTokens: 10,
    entityStateTokens: 10, recentChangeTokens: 10, policyTokens: 10, contingencyTokens: 10,
  });
  const call = prepareReasoningCall({
    store, identity: { workflow: "test_extraction", taskType: "subscription_test",
      model: "subscription-agent", promptVersion: "test-v1" }, manifest,
    now: new Date("2026-07-12T12:00:00.000Z"),
  });
  expect(() => requirePreparedReasoningCall({
    store, callId: call.callId, workflow: call.workflow, taskType: call.taskType,
    notFoundMessage: "not found", now: new Date("2026-07-12T12:31:00.000Z"),
  })).toThrow("has expired");
  const failed = failReasoningCall({
    store, call, category: "expired", now: new Date("2026-07-12T12:31:00.000Z"),
  });
  expect(failed).toMatchObject({ status: "failed", error: "expired" });
  expect(JSON.stringify(store.getModelCall(call.callId))).not.toContain("private");
});

test("prepared reasoning rejects a manifest whose stored hash no longer matches the call", () => {
  const store = testStore();
  const manifest = buildContext([], {
    maxInputTokens: 50, reservedOutputTokens: 10, sourceTokens: 10,
    entityStateTokens: 10, recentChangeTokens: 10, policyTokens: 10, contingencyTokens: 10,
  });
  const call = prepareReasoningCall({
    store,
    identity: {
      workflow: "test_extraction", taskType: "subscription_test",
      model: "subscription-agent", promptVersion: "test-v1",
    },
    manifest,
  });
  const db = store.open();
  db.query("UPDATE context_manifests SET context_hash = 'sha256:changed' WHERE call_id = ?")
    .run(call.callId);
  db.close();
  expect(() => requirePreparedReasoningCall({
    store, callId: call.callId, workflow: "test_extraction", taskType: "subscription_test",
    notFoundMessage: "prepared test call not found",
  })).toThrow("context manifest mismatch");
});

function testStore(): OperationalStore {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-prepared-")), "store.db"));
  store.migrate();
  return store;
}
