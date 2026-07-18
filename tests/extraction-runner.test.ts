import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildContext } from "../src/context/builder";
import { OperationalStore } from "../src/db/store";
import { failPreparedCallAndRetryWork, prepareReasoningCall } from "../src/orchestration/prepared-reasoning";
import { runExtractionPilot, type OneExtractionReceipt } from "../src/workflows/run-one-extraction";
import { WorkRepository } from "../src/work/repository";

test("prepared host failure atomically fails the call and releases work for retry", () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-runner-")), "store.db")); store.migrate();
  const work = new WorkRepository(store); const now = new Date("2026-07-18T12:00:00.000Z");
  const queued = work.enqueue({ workflow: "gmail_extraction", subjectType: "gmail_message",
    subjectSourceId: "primary", subjectId: "subject", anchorId: "anchor", sourceHash: "sha256:source",
    containerHash: "sha256:container", reason: "source_delta", now: now.toISOString() }).item;
  const leased = work.claimExact({ workId: queued.workId, leaseOwner: "runner", leaseDurationMs: 60_000, now })!;
  const manifest = buildContext([{ id: "source", category: "source", retrievalLevel: 0, content: {},
    tokenEstimate: 1, relevance: 1, sourceRefs: ["source"] }], { maxInputTokens: 10, reservedOutputTokens: 1,
    sourceTokens: 2, entityStateTokens: 0, recentChangeTokens: 0, policyTokens: 0, contingencyTokens: 8 }, { now });
  const call = prepareReasoningCall({ store, identity: { workflow: "gmail_extraction", taskType: "subscription_email_extraction",
    model: "test", promptVersion: "test", sourceHash: leased.sourceHash }, manifest, now });
  failPreparedCallAndRetryWork({ store, call, workId: leased.workId, leaseOwner: "runner", category: "invalid_output", now });
  expect(store.getModelCall(call.callId)).toMatchObject({ status: "failed", error: "invalid_output" });
  expect(work.get(leased.workId)).toMatchObject({ state: "pending", errorCategory: "validation" });
});

test("pilot continues after failures and returns aggregate receipts only", async () => {
  const receipts: Array<OneExtractionReceipt | Error> = [
    { provider: "gmail", status: "completed", model: "test", classification: "actionable", itemCount: 2, relationCount: 0, unresolvedCount: 1, promptInjectionDetected: false },
    new Error("private host failure"),
    { provider: "imessage", status: "completed", model: "test", classification: "ignore", itemCount: 0, relationCount: 0, unresolvedCount: 0, promptInjectionDetected: false },
  ];
  const report = await runExtractionPilot({ gmail: 2, imessage: 1, model: "test",
    runner: async () => { const next = receipts.shift()!; if (next instanceof Error) throw next; return next; } });
  expect(report).toMatchObject({ completed: { gmail: 1, imessage: 1 }, failed: { gmail: 1, imessage: 0 },
    classifications: { actionable: 1, ignore: 1 }, itemCount: 2, unresolvedCount: 1 });
  expect(JSON.stringify(report)).not.toContain("private host failure");
});
