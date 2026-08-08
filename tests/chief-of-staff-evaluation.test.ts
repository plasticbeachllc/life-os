import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { buildContext } from "../src/context/builder";
import { OperationalStore } from "../src/db/store";
import { evaluateInboxUtility, type UtilityScores } from "../src/evaluation/chief-of-staff";
import type { ModelAdapter } from "../src/orchestration/model-gateway";
import type { UiNotification, UiNotificationSummaryCandidate } from "../src/ui/notifications";

describe("chief-of-staff utility evaluation", () => {
  test("evaluates the exact bounded discussion context and returns privacy-safe diagnostics", async () => {
    const store = testStore("run_eval");
    const adapter: ModelAdapter = {
      complete: async ({ outputSchema, context }) => {
        expect(context.length).toBe(1);
        if (outputSchema?.name === "notification_opening") {
          return { output: {
            assessment: "The support request is ready for a direct response.",
            recommendedNextStep: "Reply with the requested code, then keep the credit confirmation as the completion signal.",
            question: null,
            actionRequired: true,
          }, usage: { inputTokens: 100, outputTokens: 30 } };
        }
        return { output: { scores: perfectScores(), issueCodes: [] },
          usage: { inputTokens: 140, outputTokens: 20 } };
      },
    };
    const result = await evaluateInboxUtility({
      store,
      runId: "run_eval",
      notifications: [notification()],
      candidates: [candidate()],
      adapter,
      model: "test-model",
      maxCases: 3,
    });

    expect(result.score).toBe(100);
    expect(result.completed).toBe(1);
    expect(result.cases[0]?.signals).toEqual({
      hasNamedParticipants: true, hasSourceAction: true, actionRequired: true, contextItems: 1,
    });
    expect(JSON.stringify(result)).not.toContain("Thompson Tee");
    expect(store.countRows("context_manifests")).toBe(2);
    expect(store.countRows("model_calls")).toBe(2);
    const db = store.open();
    const manifests = db.query<{ included_items_json: string }, []>(
      "SELECT included_items_json FROM context_manifests",
    ).all();
    db.close();
    expect(manifests.every((item) => !item.included_items_json.includes("The support request is ready"))).toBe(true);
  });

  test("continues after a generation failure without persisting model prose", async () => {
    const store = testStore("run_eval_failure");
    const result = await evaluateInboxUtility({
      store,
      runId: "run_eval_failure",
      notifications: [notification()],
      candidates: [candidate()],
      adapter: { complete: async () => { throw new Error("private provider failure"); } },
      model: "test-model",
      maxCases: 1,
    });

    expect(result).toMatchObject({ completed: 0, failed: 1, score: null,
      issueCounts: { opening_generation_failed: 1 } });
    const db = store.open();
    const calls = db.query<{ error: string }, []>("SELECT error FROM model_calls").all();
    db.close();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.error).toBe("private provider failure");
  });
});

function testStore(runId: string): OperationalStore {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-eval-")), "store.db"));
  store.migrate();
  store.recordRun({ runId, workflow: "test-evaluation", mode: "test",
    startedAt: new Date().toISOString(), status: "running" });
  return store;
}

function notification(): UiNotification {
  return {
    id: "ui_12345678901234567890",
    kind: "email",
    category: "needs_you",
    tone: "question",
    status: "open",
    title: "A response is needed",
    summary: "Support is waiting for requested information.",
    relativeTime: "Now",
    primaryAction: { kind: "discuss", label: "Discuss" },
    sourceAction: { kind: "open_email", label: "Open email", href: "/safe" },
  };
}

function candidate(): UiNotificationSummaryCandidate {
  const manifest = buildContext([{
    id: "context-one",
    category: "entity_state",
    retrievalLevel: 1,
    content: {
      notification: { title: "A response is needed", summary: "Support is waiting." },
      source: { participant_labels: ["Thompson Tee support"], follow_up_available: "Open the source email in Gmail" },
    },
    tokenEstimate: 80,
    relevance: 1,
    impact: 1,
    sourceRefs: ["opaque"],
  }], {
    maxInputTokens: 500,
    reservedOutputTokens: 100,
    sourceTokens: 0,
    entityStateTokens: 300,
    recentChangeTokens: 0,
    policyTokens: 0,
    contingencyTokens: 100,
  });
  return {
    notificationId: "ui_12345678901234567890",
    cacheKey: "cache",
    model: "test-model",
    promptVersion: "opening-v1",
    schemaVersion: "schema-v1",
    policyVersion: "policy-v1",
    sourceHash: "sha256:test",
    manifest,
    actionRequired: true,
  };
}

function perfectScores(): UtilityScores {
  return { relevance: 5, specificity: 5, actionability: 5, grounding: 5,
    prioritization: 5, concision: 5 };
}
