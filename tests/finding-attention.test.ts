import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";
import { projectExtractionFindings } from "../src/findings/projector";
import { FindingStore } from "../src/findings/store";
import { rebuildChiefOfStaffState } from "../src/state/chief-of-staff";
import { rebuildFindingAttentionState } from "../src/state/finding-attention";
import { generateMorningBriefing, type MorningBriefing } from "../src/workflows/morning-briefing";

test("active findings rebuild into stable attention and chief-of-staff projections", () => {
  const store = fixture();
  const now = new Date("2026-07-12T09:00:00.000Z");
  const first = rebuildFindingAttentionState({ store, now });
  const unchanged = rebuildFindingAttentionState({ store, now });
  expect(unchanged.stateId).toBe(first.stateId);
  expect(first.content).toMatchObject({
    open_loop_count: 2, commitment_count: 1, overdue_count: 1, signal_count: 1,
  });
  const openLoops = first.content.open_loops as Array<Record<string, unknown>>;
  expect(openLoops.map((finding) => finding.statement)).toEqual([
    "Submit the renewal form", "Confirm the meeting time",
  ]);
  expect(JSON.stringify(first.content)).not.toContain("gmail:");
  expect(JSON.stringify(first.content)).not.toContain("sha256:");
  expect(JSON.stringify(first.content)).not.toContain("extract_");
  expect(first.content.signals).toEqual([
    expect.objectContaining({
      type: "commitment_at_risk", summary: "Submit the renewal form",
      suggested_interventions: [expect.objectContaining({ kind: "create_task", readiness: "ready" })],
    }),
  ]);

  const overdueFindingId = String((first.content.overdue_finding_ids as string[])[0]);
  const chief = rebuildChiefOfStaffState({ store, now });
  expect(chief.content.overdue_commitments).toContain(overdueFindingId);
  expect(chief.content.active_finding_open_loops).toHaveLength(2);
  expect(chief.content.active_finding_commitments).toEqual([overdueFindingId]);
  expect(chief.content.active_attention_signals).toEqual([
    expect.objectContaining({
      type: "commitment_at_risk", summary: "Submit the renewal form",
      finding_ids: [overdueFindingId],
    }),
  ]);
  expect(chief.content.suggested_focus).toContain("Resolve 1 overdue commitment(s).");

  const briefing = generateMorningBriefing({ store, now }).state.content as unknown as MorningBriefing;
  expect(briefing.overdue).toEqual([{
    summary: "Overdue: Submit the renewal form",
    evidenceIds: [overdueFindingId, first.stateId],
  }]);
  expect(briefing.attention).toEqual([{
    summary: "commitment at risk: Submit the renewal form",
    evidenceIds: [
      expect.stringMatching(/^attention_/), overdueFindingId, first.stateId,
    ],
  }]);
});

test("a finding status event removes it from regenerated attention state", () => {
  const store = fixture();
  const now = new Date("2026-07-12T09:00:00.000Z");
  const first = rebuildFindingAttentionState({ store, now });
  const overdueFindingId = String((first.content.overdue_finding_ids as string[])[0]);
  new FindingStore(store).dismiss({
    findingId: overdueFindingId, reason: "No longer relevant",
    createdAt: "2026-07-12T10:00:00.000Z",
  });
  const changed = rebuildFindingAttentionState({ store, now });
  expect(changed.stateVersion).toBe(2);
  expect(changed.content).toMatchObject({
    open_loop_count: 1, commitment_count: 0, overdue_count: 0, signal_count: 0,
    overdue_finding_ids: [],
  });
  expect(new FindingStore(store).review().byStatus).toEqual({ dismissed: 1, active: 2 });
});

test("a matching canonical task invalidates and resolves untracked commitment attention", () => {
  const store = fixture();
  const now = new Date("2026-07-09T09:00:00.000Z");
  const first = rebuildFindingAttentionState({ store, now });
  expect(first.content.signals).toEqual([
    expect.objectContaining({
      type: "untracked_user_commitment", summary: "Submit the renewal form",
    }),
  ]);

  store.saveDerivedState({
    stateId: "state_task_renewal", stateType: "task_state", entityId: "task_renewal",
    stateVersion: 1,
    content: {
      task_id: "task_renewal", description: "Submit the renewal form", status: "open",
      due_date: "2026-07-10",
    },
    sourceHashes: ["sha256:task-renewal"], generationMethod: "test",
    builderName: "task-state", builderVersion: "test",
    inputProvenance: [{ type: "test", id: "task_renewal", hash: "sha256:task-renewal" }],
    dependencyHash: "sha256:task-renewal", createdAt: now.toISOString(),
  });
  const resolved = rebuildFindingAttentionState({ store, now });

  expect(resolved.stateVersion).toBe(2);
  expect(resolved.content).toMatchObject({
    signal_count: 0,
    signals: [],
    suppressed: { tracked_commitments: 1, low_confidence_findings: 0, unsupported_findings: 2 },
  });
  expect(resolved.inputProvenance).toContainEqual({
    type: "task_state", id: "task_renewal", hash: "sha256:task-renewal",
  });
});

function fixture(): OperationalStore {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-attention-")), "store.db"));
  store.migrate();
  store.recordModelCall({
    callId: "call_attention", workflow: "gmail_extraction",
    taskType: "subscription_email_extraction", model: "test", promptVersion: "v1",
    sourceHash: "sha256:source", contextHash: "sha256:context", cached: false,
    startedAt: "2026-07-12T08:00:00.000Z", completedAt: "2026-07-12T08:00:01.000Z",
    status: "completed",
  });
  projectExtractionFindings({
    store,
    extraction: {
      sourceType: "gmail_extraction", extractionId: "extract_attention",
      callId: "call_attention", createdAt: "2026-07-12T08:00:01.000Z",
      output: { items: [
        {
          kind: "user_commitment", statement: "Submit the renewal form", owner: "user",
          dueDate: "2026-07-10", confidence: 0.95, ambiguities: [],
          evidenceIds: ["gmail:m1:sha256:private"],
        },
        {
          kind: "explicit_request", statement: "Confirm the meeting time", owner: "user",
          dueDate: "2026-07-15", confidence: 0.9, ambiguities: [],
          evidenceIds: ["gmail:m1:sha256:private"],
        },
        {
          kind: "decision", statement: "Use the annual plan", owner: "shared",
          dueDate: null, confidence: 1, ambiguities: [],
          evidenceIds: ["gmail:m1:sha256:private"],
        },
      ] },
    },
  });
  return store;
}
