import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";
import { backfillExtractionFindings, projectExtractionFindings } from "../src/findings/projector";
import { FindingStore } from "../src/findings/store";
import { GmailStore } from "../src/gmail/store";
import { IMessageStore } from "../src/imessage/store";

test("provider extraction items project idempotently into sanitized common findings", () => {
  const store = testStore();
  recordCall(store, "call_gmail", "gmail_extraction", "subscription_email_extraction");
  recordCall(store, "call_message", "imessage_extraction", "subscription_imessage_extraction");
  const gmail = {
    sourceType: "gmail_extraction" as const,
    extractionId: "extract_gmail",
    callId: "call_gmail",
    createdAt: "2026-07-12T12:00:00.000Z",
    output: { items: [{
      kind: "explicit_request", statement: "Send the revised proposal", owner: "user",
      dueDate: "2026-07-15", confidence: 0.95, ambiguities: [],
      evidenceIds: ["gmail:provider-message:sha256:private-source-hash"],
    }] },
  };
  const message = {
    sourceType: "imessage_extraction" as const,
    extractionId: "extract_message",
    callId: "call_message",
    createdAt: "2026-07-12T12:01:00.000Z",
    output: { items: [{
      kind: "open_loop", statement: "Confirm Thursday's meeting place", owner: "shared",
      dueDate: null, confidence: 0.8, ambiguities: ["The exact place is unresolved."],
      evidenceIds: ["imessage:provider-message:sha256:private-source-hash"],
    }] },
  };

  expect(projectExtractionFindings({ store, extraction: gmail })).toEqual({ created: 1, unchanged: 0 });
  expect(projectExtractionFindings({ store, extraction: message })).toEqual({ created: 1, unchanged: 0 });
  expect(projectExtractionFindings({ store, extraction: gmail })).toEqual({ created: 0, unchanged: 1 });
  expect(store.countRows("findings")).toBe(2);
  expect(store.countRows("finding_status_events")).toBe(2);

  const review = new FindingStore(store).review();
  expect(review).toMatchObject({
    total: 2,
    byKind: { explicit_request: 1, open_loop: 1 },
    byStatus: { active: 2 },
  });
  expect(review.findings[0]).toMatchObject({ evidenceCount: 1, status: "active" });
  const serialized = JSON.stringify(review);
  expect(serialized).not.toContain("extract_gmail");
  expect(serialized).not.toContain("call_gmail");
  expect(serialized).not.toContain("provider-message");
  expect(serialized).not.toContain("private-source-hash");
  expect(serialized).not.toContain("sha256:");
});

test("finding projection rejects invalid items and immutable projection conflicts", () => {
  const store = testStore();
  recordCall(store, "call_test", "gmail_extraction", "subscription_email_extraction");
  const extraction = {
    sourceType: "gmail_extraction" as const,
    extractionId: "extract_test", callId: "call_test", createdAt: "2026-07-12T12:00:00.000Z",
    output: { items: [{
      kind: "open_loop", statement: "Original", owner: "user", dueDate: null,
      confidence: 1, ambiguities: [], evidenceIds: ["gmail:m1:sha256:one"],
    }] },
  };
  projectExtractionFindings({ store, extraction });
  expect(() => projectExtractionFindings({
    store,
    extraction: {
      ...extraction,
      output: { items: [{
        kind: "open_loop", statement: "Changed", owner: "user", dueDate: null,
        confidence: 1, ambiguities: [], evidenceIds: ["gmail:m1:sha256:one"],
      }] },
    },
  })).toThrow("immutable finding projection conflicts");
  expect(() => projectExtractionFindings({
    store,
    extraction: {
      ...extraction, extractionId: "extract_invalid",
      output: { items: [{ kind: "unknown", statement: "Invalid" }] },
    },
  })).toThrow("cannot be projected");
  expect(store.countRows("findings")).toBe(1);
});

test("finding lifecycle dismissal and supersession are explicit and append-only", () => {
  const store = testStore();
  recordCall(store, "call_lifecycle", "gmail_extraction", "subscription_email_extraction");
  projectExtractionFindings({
    store,
    extraction: {
      sourceType: "gmail_extraction", extractionId: "extract_lifecycle",
      callId: "call_lifecycle", createdAt: "2026-07-12T12:00:00.000Z",
      output: { items: [
        { kind: "open_loop", statement: "Old plan", owner: "user", dueDate: null,
          confidence: 1, ambiguities: [], evidenceIds: ["gmail:m1:sha256:one"] },
        { kind: "open_loop", statement: "Replacement plan", owner: "user", dueDate: null,
          confidence: 1, ambiguities: [], evidenceIds: ["gmail:m2:sha256:two"] },
        { kind: "open_loop", statement: "Dismiss me", owner: "user", dueDate: null,
          confidence: 1, ambiguities: [], evidenceIds: ["gmail:m3:sha256:three"] },
      ] },
    },
  });
  const active = new FindingStore(store).review().findings;
  const old = active.find((finding) => finding.statement === "Old plan")!;
  const replacement = active.find((finding) => finding.statement === "Replacement plan")!;
  const dismissed = active.find((finding) => finding.statement === "Dismiss me")!;
  const findings = new FindingStore(store);
  findings.supersede({
    findingId: old.findingId, replacementFindingId: replacement.findingId,
    reason: "A newer explicit plan replaced it", createdAt: "2026-07-12T13:00:00.000Z",
  });
  findings.dismiss({
    findingId: dismissed.findingId, reason: "User reviewed it as irrelevant",
    createdAt: "2026-07-12T13:01:00.000Z",
  });
  expect(findings.get(old.findingId)?.status).toBe("superseded");
  expect(findings.get(replacement.findingId)?.status).toBe("active");
  expect(findings.get(dismissed.findingId)?.status).toBe("dismissed");
  expect(() => findings.dismiss({ findingId: old.findingId, reason: "again" }))
    .toThrow("not active");
  expect(() => findings.supersede({
    findingId: replacement.findingId, replacementFindingId: replacement.findingId, reason: "self",
  })).toThrow("supersede itself");
  expect(store.countRows("finding_status_events")).toBe(5);
});

test("finding backfill processes existing Gmail and Messages extractions without model work", () => {
  const store = testStore();
  recordCall(store, "call_gmail_backfill", "gmail_extraction", "subscription_email_extraction");
  recordCall(store, "call_message_backfill", "imessage_extraction", "subscription_imessage_extraction");
  seedProviderSources(store);
  const output = (kind: "decision" | "relationship_update") => ({
    items: [{
      kind, statement: kind === "decision" ? "Use the revised plan" : "Alex changed roles",
      owner: "shared", dueDate: null, confidence: 0.9, ambiguities: [],
      evidenceIds: [`evidence:${kind}`],
    }],
  });
  new GmailStore(store).saveExtraction({
    extractionId: "extract_gmail_backfill", accountId: "me", messageId: "m1",
    sourceHash: "sha256:gmail-source", threadStateHash: "sha256:thread",
    callId: "call_gmail_backfill", classification: "decision", output: output("decision"),
    promptVersion: "v1", schemaVersion: "s1", policyVersion: "p1", model: "test",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
  new IMessageStore(store).saveExtraction({
    extractionId: "extract_message_backfill", sourceId: "local-messages", messageId: "imsg_1",
    sourceHash: "sha256:message-source", conversationId: "imchat_1",
    conversationStateHash: "sha256:conversation", callId: "call_message_backfill",
    classification: "relationship_update", output: output("relationship_update"),
    promptVersion: "v1", schemaVersion: "s1", policyVersion: "p1", model: "test",
    createdAt: "2026-07-12T12:01:00.000Z",
  });
  expect(store.countRows("model_calls")).toBe(2);
  expect(backfillExtractionFindings(store)).toEqual({ extractions: 2, created: 2, unchanged: 0 });
  expect(backfillExtractionFindings(store)).toEqual({ extractions: 2, created: 0, unchanged: 2 });
  expect(store.countRows("model_calls")).toBe(2);
  expect(new FindingStore(store).review()).toMatchObject({
    total: 2, byKind: { decision: 1, relationship_update: 1 },
  });
});

function testStore(): OperationalStore {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-findings-")), "store.db"));
  store.migrate();
  return store;
}

function recordCall(store: OperationalStore, callId: string, workflow: string, taskType: string): void {
  store.recordModelCall({
    callId, workflow, taskType, model: "test", promptVersion: "v1",
    sourceHash: `sha256:${callId}`, contextHash: `sha256:context-${callId}`,
    cached: false, startedAt: "2026-07-12T12:00:00.000Z",
    completedAt: "2026-07-12T12:00:01.000Z", status: "completed",
  });
}

function seedProviderSources(store: OperationalStore): void {
  const db = store.open();
  try {
    db.query("INSERT INTO gmail_accounts VALUES (?, ?, 'IMPORTANT', NULL, ?, ?)")
      .run("me", "user@example.com", "now", "now");
    db.query(`INSERT INTO gmail_messages (
      account_id, message_id, thread_id, internal_date, to_addresses_json, cc_addresses_json,
      selected_important, content_hash, current_version_hash, ingestion_state,
      first_ingested_at, last_ingested_at
    ) VALUES ('me', 'm1', 't1', '1', '[]', '[]', 1, 'sha256:gmail-source',
      'sha256:gmail-source', 'ingested', 'now', 'now')`).run();
    db.query(`INSERT INTO imessage_sources (
      source_id, last_row_id, normalizer_version, created_at, updated_at
    ) VALUES ('local-messages', 1, 'v1', 'now', 'now')`).run();
    db.query(`INSERT INTO imessage_messages (
      source_id, message_id, conversation_id, source_row_id, sent_at, direction, service,
      participant_set_hash, content_hash, text_hash, text_character_count, text_available,
      first_ingested_at, last_ingested_at
    ) VALUES ('local-messages', 'imsg_1', 'imchat_1', 1, '2026-07-12T12:00:00.000Z',
      'incoming', 'iMessage', 'sha256:participants', 'sha256:message-source',
      'sha256:text', 4, 1, 'now', 'now')`).run();
  } finally {
    db.close();
  }
}
