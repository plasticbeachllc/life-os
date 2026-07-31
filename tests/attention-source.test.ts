import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttentionReviewItem } from "../src/attention/review";
import { OperationalStore } from "../src/db/store";
import { attentionSourceContext, gmailThreadUrlForAttention } from "../src/ui/attention-source";

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("attention source context", () => {
  test("provides safe labels and a fixed Gmail destination for email-backed findings", () => {
    directory = mkdtempSync(join(tmpdir(), "life-os-attention-source-"));
    const store = new OperationalStore(join(directory, "store.db"));
    store.migrate();
    store.saveDerivedState({
      stateId: "person-state-1", stateType: "person_state", stateVersion: 1,
      entityId: "person-taylor",
      content: { display_name: "Taylor", emails: ["owner@example.com"] },
      sourceHashes: ["sha256:person"], generationMethod: "test",
      createdAt: "2026-07-31T12:00:00.000Z",
    });
    const db = store.open();
    try {
      db.query(`INSERT INTO gmail_accounts (
        account_id, email_address, selection_label_id, last_history_id, created_at, updated_at
      ) VALUES ('me', 'owner@example.com', 'IMPORTANT_OR_SENT', NULL, ?, ?)`)
        .run("2026-07-31T12:00:00.000Z", "2026-07-31T12:00:00.000Z");
      db.query(`INSERT INTO gmail_messages (
        account_id, message_id, thread_id, internal_date, from_address,
        to_addresses_json, cc_addresses_json, subject, rfc_message_id,
        selected_important, content_hash, current_version_hash, ingestion_state,
        first_ingested_at, last_ingested_at
      ) VALUES ('me', 'message1', 'thread_ABC-123', '1', ?, ?, '[]', NULL, NULL,
        1, 'sha256:source', 'sha256:source', 'extracted', ?, ?)`)
        .run(
          "Thompson Tee Support <help@example.com>",
          JSON.stringify(["owner@example.com"]),
          "2026-07-31T12:00:00.000Z", "2026-07-31T12:00:00.000Z",
        );
      db.query(`INSERT INTO model_calls (
        call_id, workflow, task_type, model, prompt_version, source_hash,
        context_hash, started_at, completed_at, status
      ) VALUES ('call1', 'gmail_extraction', 'subscription_email_extraction',
        'test', 'test', 'sha256:source', 'sha256:context', ?, ?, 'completed')`)
        .run("2026-07-31T12:00:00.000Z", "2026-07-31T12:00:00.000Z");
      db.query(`INSERT INTO gmail_extractions (
        extraction_id, account_id, message_id, source_hash, thread_state_hash,
        call_id, classification, output_json, prompt_version, schema_version,
        policy_version, model, created_at
      ) VALUES ('extract1', 'me', 'message1', 'sha256:source', 'sha256:thread',
        'call1', 'actionable', '{}', 'test', 'test', 'test', 'test', ?)`)
        .run("2026-07-31T12:00:00.000Z");
      db.query(`INSERT INTO findings (
        finding_id, source_type, source_extraction_id, source_item_index,
        reasoning_call_id, kind, statement, owner, due_date, confidence,
        ambiguities_json, evidence_json, evidence_count, content_hash, created_at
      ) VALUES ('finding1', 'gmail_extraction', 'extract1', 0, 'call1',
        'explicit_request', ?, 'user', NULL, 0.99, '[]', '["evidence1"]', 1,
        'sha256:finding', ?)`)
        .run(
          "Reply to Thompson Tee Support with the coupon code.",
          "2026-07-31T12:00:00.000Z",
        );
      db.query(`INSERT INTO finding_status_events (
        event_id, finding_id, status, created_at
      ) VALUES ('event1', 'finding1', 'active', ?)`)
        .run("2026-07-31T12:00:00.000Z");
    } finally {
      db.close();
    }

    const item = attentionItem(["finding1"]);
    expect(attentionSourceContext(store, item)).toEqual({
      findingStatements: ["Reply to Thompson Tee Support with the coupon code."],
      participantLabels: ["Thompson Tee Support", "Taylor"],
      sourceKind: "gmail",
      canOpenEmail: true,
    });
    expect(gmailThreadUrlForAttention(store, item))
      .toBe("https://mail.google.com/mail/#all/thread_ABC-123");
  });

  test("rejects unsafe provider thread identifiers", () => {
    directory = mkdtempSync(join(tmpdir(), "life-os-attention-source-"));
    const store = new OperationalStore(join(directory, "store.db"));
    store.migrate();
    expect(gmailThreadUrlForAttention(store, attentionItem(["missing"]))).toBeUndefined();
  });
});

function attentionItem(findingIds: string[]): AttentionReviewItem {
  return {
    attentionId: "attention1", type: "response_needed", title: "Reply needed",
    summary: "A response is needed.", owner: "user", confidence: 1,
    impact: "medium", urgency: "soon", dueDate: null, explanation: "Awaiting response.",
    ambiguities: [], findingIds, interventions: [],
    presentation: {
      channel: "review_queue", reason: "reviewable_intervention",
      explanation: "Review it.", policyVersion: "attention-presentation-v1",
    },
  };
}
