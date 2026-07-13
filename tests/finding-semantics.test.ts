import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SemanticFinding } from "../src/findings/contract";
import { deriveFindingSemantics } from "../src/findings/semantics";
import { FindingStore, saveFindingSemanticsInTransaction } from "../src/findings/store";
import { OperationalStore } from "../src/db/store";
import { rebuildFindingAttentionState } from "../src/state/finding-attention";

test("communication semantics are deterministic and relations bind current content", () => {
  const request = finding("request", "explicit_request", "user", "gmail:request:sha256:one");
  const response = finding("response", "open_loop", "user", "gmail:response:sha256:two");
  const result = deriveFindingSemantics({
    findings: [response],
    evidenceDirections: new Map([[response.evidenceIds[0]!, "outgoing"]]),
    relations: [{ kind: "responds_to", fromItemIndex: 0, toFindingId: request.findingId,
      confidence: 0.97, evidenceIds: response.evidenceIds }],
    priorFindings: [{ findingId: request.findingId, kind: request.kind,
      statement: request.statement, owner: request.owner, dueDate: null, contentHash: request.contentHash }],
    relationValidatorVersion: "fixture-prompt-v1",
  });

  expect(result.communicationContexts).toEqual([expect.objectContaining({
    findingId: response.findingId, direction: "outgoing", responseExpectation: "none",
    responseState: "unknown", validatorMethod: "deterministic",
  })]);
  expect(result.relations).toEqual([expect.objectContaining({
    kind: "responds_to", fromFindingId: response.findingId, toFindingId: request.findingId,
    validatorMethod: "validated_reasoning", validatorVersion: "fixture-prompt-v1",
  })]);
  expect(result.relations[0]?.contentHash).toStartWith("sha256:");
});

test("incoming requests become required while unsupported relations fail closed", () => {
  const request = finding("request", "explicit_request", "user", "imessage:request:sha256:one");
  const incoming = deriveFindingSemantics({
    findings: [request], evidenceDirections: new Map([[request.evidenceIds[0]!, "incoming"]]),
    relations: [], priorFindings: [], relationValidatorVersion: "fixture-prompt-v1",
  });
  expect(incoming.communicationContexts[0]).toMatchObject({
    direction: "incoming", responseExpectation: "required", responseState: "awaiting_response",
  });

  expect(() => deriveFindingSemantics({
    findings: [request], evidenceDirections: new Map([[request.evidenceIds[0]!, "incoming"]]),
    relations: [{ kind: "responds_to", fromItemIndex: 0, toFindingId: "finding_prior",
      confidence: 0.9, evidenceIds: request.evidenceIds }],
    priorFindings: [{ findingId: "finding_prior", kind: "explicit_request", statement: "Reply",
      owner: "user", dueDate: null, contentHash: "sha256:prior" }],
    relationValidatorVersion: "fixture-prompt-v1",
  })).toThrow("response relation is incompatible");
});

test("persisted resolution relations become explicit current attention", () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-finding-semantics-")), "store.db"));
  store.migrate();
  store.recordModelCall({
    callId: "call_semantics", workflow: "gmail_extraction", taskType: "subscription_email_extraction",
    model: "test", promptVersion: "fixture-prompt-v1", sourceHash: "sha256:source",
    contextHash: "sha256:context", cached: false, startedAt: "2026-07-12T08:00:00.000Z",
    completedAt: "2026-07-12T08:00:01.000Z", status: "completed",
  });
  const commitment = { ...finding("commitment", "user_commitment", "user", "gmail:commitment:sha256:one"),
    reasoningCallId: "call_semantics", dueDate: "2026-07-10" };
  const completion = { ...finding("completion", "project_update", "shared", "gmail:completion:sha256:two"),
    reasoningCallId: "call_semantics" };
  new FindingStore(store).saveProjection([commitment, completion]);
  const semantics = deriveFindingSemantics({
    findings: [commitment, completion],
    evidenceDirections: new Map([
      [commitment.evidenceIds[0]!, "outgoing"], [completion.evidenceIds[0]!, "incoming"],
    ]),
    relations: [{ kind: "resolves", fromItemIndex: 1, toFindingId: commitment.findingId,
      confidence: 0.96, evidenceIds: completion.evidenceIds }],
    priorFindings: [{ findingId: commitment.findingId, kind: commitment.kind,
      statement: commitment.statement, owner: commitment.owner,
      dueDate: commitment.dueDate, contentHash: commitment.contentHash }],
    relationValidatorVersion: "fixture-prompt-v1",
  });
  const db = store.open();
  try { db.transaction(() => saveFindingSemanticsInTransaction(db, semantics))(); }
  finally { db.close(); }

  const state = rebuildFindingAttentionState({ store, now: new Date("2026-07-12T09:00:00.000Z") });
  expect(state.content.signals).toContainEqual(expect.objectContaining({ type: "commitment_resolved" }));
  expect(state.inputProvenance).toContainEqual(expect.objectContaining({
    type: "finding_relation", id: semantics.relations[0]?.relationId,
  }));
});

function finding(
  suffix: string, kind: SemanticFinding["kind"], owner: SemanticFinding["owner"], evidenceId: string,
): SemanticFinding {
  return {
    findingId: `finding_${suffix}`, sourceType: "gmail_extraction",
    sourceExtractionId: `extract_${suffix}`, sourceItemIndex: 0,
    reasoningCallId: `call_${suffix}`, kind, statement: `Statement ${suffix}`, owner,
    dueDate: null, confidence: 0.95, ambiguities: [], evidenceIds: [evidenceId],
    contentHash: `sha256:${suffix}`, createdAt: "2026-07-12T09:00:00.000Z",
  };
}
