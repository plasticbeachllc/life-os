import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";
import {
  prepareSubscriptionMorningReasoning,
  submitSubscriptionMorningReasoning,
} from "../src/workflows/subscription-reasoning";

function fixture(): OperationalStore {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-subscription-")), "store.db"));
  store.migrate();
  store.saveDerivedState({
    stateId: "state_chief", stateType: "chief_of_staff_state", stateVersion: 1,
    content: { current_priorities: [], active_risks: [] }, sourceHashes: ["sha256:chief"],
    generationMethod: "test", createdAt: "2026-07-12T08:00:00Z",
  });
  store.saveDerivedState({
    stateId: "state_daily", stateType: "daily_state", entityId: "2026-07-12", stateVersion: 1,
    content: {
      recentCompletions: [{ summary: "Completed task", evidenceIds: ["task_done", "state_task"] }],
    },
    sourceHashes: ["sha256:daily"], generationMethod: "test", createdAt: "2026-07-12T08:00:00Z",
  });
  return store;
}

test("subscription reasoning validates evidence, records usage, and caches result", () => {
  const store = fixture();
  const prepared = prepareSubscriptionMorningReasoning({ store, model: "subscription-model", policyVersion: "sha256:policy" });
  expect(prepared.cached).toBe(false);
  expect(prepared.allowedEvidenceIds).toContain("task_done");
  expect(store.countRows("context_manifests")).toBe(1);
  const auditDb = store.open();
  const audit = auditDb.query<{ included_items_json: string }, [string]>(
    "SELECT included_items_json FROM context_manifests WHERE call_id = ?",
  ).get(prepared.callId!)!.included_items_json;
  auditDb.close();
  expect(audit).not.toContain("Completed task");

  expect(() => submitSubscriptionMorningReasoning({
    store, callId: prepared.callId!,
    recommendations: [{ summary: "Invented", reason: "No evidence", evidenceIds: ["task_fake"], confidence: 0.5 }],
  })).toThrow("unrecognized evidence");

  const state = submitSubscriptionMorningReasoning({
    store, callId: prepared.callId!, inputTokens: 150, outputTokens: 30,
    recommendations: [{
      summary: "Acknowledge the completed task", reason: "It changed recently",
      evidenceIds: ["task_done"], confidence: 0.9,
    }],
  });
  expect(state.content.recommendations).toHaveLength(1);
  expect(store.getModelCall(prepared.callId!)?.status).toBe("completed");
  expect(store.efficiencyMetrics().inputTokens).toBe(150);

  const cached = prepareSubscriptionMorningReasoning({ store, model: "subscription-model", policyVersion: "sha256:policy" });
  expect(cached.cached).toBe(true);
  expect(cached.state?.stateId).toBe(state.stateId);
});

test("subscription reasoning rejects a superseded compact state", () => {
  const store = fixture();
  const prepared = prepareSubscriptionMorningReasoning({
    store, model: "subscription-model", policyVersion: "sha256:policy",
  });
  store.saveDerivedState({
    stateId: "state_chief_v2", stateType: "chief_of_staff_state", stateVersion: 2,
    content: { current_priorities: [], active_risks: [], important_recent_changes: ["changed"] },
    sourceHashes: ["sha256:chief-v2"], generationMethod: "test",
    createdAt: "2026-07-12T08:01:00Z",
  });
  expect(() => submitSubscriptionMorningReasoning({
    store, callId: prepared.callId!, recommendations: [],
  })).toThrow("contextual state changed");
  expect(store.getModelCall(prepared.callId!)?.status).toBe("failed");
  expect(store.getModelCall(prepared.callId!)?.error).toBe("context_changed");
});
