import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GmailApiMessage, GmailApiThread, GmailSourceAdapter } from "../src/adapters/gmail";
import { OperationalStore } from "../src/db/store";
import { normalizeGmailMessage } from "../src/gmail/normalizer";
import { GmailStore, gmailThreadStateHash } from "../src/gmail/store";
import {
  prepareGmailReplyDraft, submitGmailReplyDraft, validateGmailReplyDraft,
} from "../src/workflows/gmail-reply-draft";

setDefaultTimeout(15_000);
let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Gmail reply drafting", () => {
  test("prepares bounded context, validates a draft, and retains no source or draft text", async () => {
    const fixture = setup();
    const prepared = await prepareGmailReplyDraft({
      adapter: fixture.adapter, store: fixture.store, accountId: "me", threadId: "thread1",
      expectedThreadStateHash: fixture.threadHash,
      findingStatements: ["Reply to Thompson Tee Support with the coupon code."],
      participantLabels: ["Thompson Tee Support", "Taylor"], draftKind: "reply",
      model: "test-model", policyVersion: "policy-v1",
    });

    expect(prepared.allowedEvidenceIds).toHaveLength(2);
    expect(JSON.stringify(prepared.context)).toContain("Thompson Tee Support");
    expect(JSON.stringify(prepared.context)).toContain("Please send the coupon code");
    const output = {
      status: "ready" as const,
      body: "Hi Thompson Tee Support,\n\nThe coupon code is SWEATFREE15. Please apply it to the order.\n\nThanks,\nTaylor",
      clarification: null,
      evidenceIds: [prepared.allowedEvidenceIds.at(-1)!], assumptions: [],
    };
    expect(await submitGmailReplyDraft({
      adapter: fixture.adapter, store: fixture.store, callId: prepared.callId,
      accountId: "me", threadId: "thread1", expectedThreadStateHash: fixture.threadHash,
      policyVersion: "policy-v1", output,
    })).toEqual(output);
    expect(fixture.store.getModelCall(prepared.callId)?.status).toBe("completed");

    const db = fixture.store.open();
    try {
      const retained = JSON.stringify({
        calls: db.query("SELECT * FROM model_calls").all(),
        manifests: db.query("SELECT * FROM context_manifests").all(),
      });
      expect(retained).not.toContain("Please send the coupon code");
      expect(retained).not.toContain("SWEATFREE15");
      expect(retained).not.toContain(output.body);
      expect(retained).toContain("transient_thread_content_omitted");
    } finally { db.close(); }
  });

  test("rejects a draft when the live Gmail thread changes after preparation", async () => {
    const fixture = setup();
    const prepared = await prepareGmailReplyDraft({
      adapter: fixture.adapter, store: fixture.store, accountId: "me", threadId: "thread1",
      expectedThreadStateHash: fixture.threadHash,
      findingStatements: ["Reply to Thompson Tee Support."],
      participantLabels: ["Thompson Tee Support"], draftKind: "reply",
      model: "test-model", policyVersion: "policy-v1",
    });
    fixture.thread.messages!.push(message({
      id: "message3", body: "Never mind, this is resolved.", internalDate: "3000",
    }));
    await expect(submitGmailReplyDraft({
      adapter: fixture.adapter, store: fixture.store, callId: prepared.callId,
      accountId: "me", threadId: "thread1", expectedThreadStateHash: fixture.threadHash,
      policyVersion: "policy-v1",
      output: { status: "ready", body: "Thanks, I will reply.", clarification: null,
        evidenceIds: [prepared.allowedEvidenceIds[0]!], assumptions: [] },
    })).rejects.toThrow("thread changed");
    expect(fixture.store.getModelCall(prepared.callId)?.status).toBe("failed");
    expect(fixture.store.getModelCall(prepared.callId)?.error).toBe("stale_source");
  });

  test("rejects unsafe or structurally inconsistent model output", () => {
    const allowed = new Set(["gmail:message1:sha256:source"]);
    expect(() => validateGmailReplyDraft({
      status: "ready", body: "Open https://example.com", clarification: null,
      evidenceIds: [...allowed], assumptions: [],
    }, allowed)).toThrow("invalid or unsafe");
    expect(() => validateGmailReplyDraft({
      status: "needs_clarification", body: "A premature draft", clarification: "Which date?",
      evidenceIds: [...allowed], assumptions: [],
    }, allowed)).toThrow("clarification is invalid");
  });
});

function setup(): {
  store: OperationalStore; adapter: FakeAdapter; thread: GmailApiThread; threadHash: string;
} {
  directory = mkdtempSync(join(tmpdir(), "life-os-gmail-draft-"));
  const store = new OperationalStore(join(directory, "store.db"));
  store.migrate();
  const messages = [
    message({ id: "message1", body: "We can apply the discount. Please send the coupon code.", internalDate: "1000" }),
    message({ id: "message2", body: "I will find it and reply shortly.", internalDate: "2000", labels: ["SENT"] }),
  ];
  const thread: GmailApiThread = { id: "thread1", messages };
  const normalized = messages.map(normalizeGmailMessage);
  const gmail = new GmailStore(store);
  gmail.upsertAccount({
    accountId: "me", emailAddress: "user@example.com",
    selectionLabelId: "IMPORTANT_OR_SENT", now: "2026-08-04T12:00:00.000Z",
  });
  for (const item of normalized) gmail.saveMessageAndThread({
    accountId: "me", message: item, threadMessages: normalized,
    now: "2026-08-04T12:00:00.000Z",
  });
  return { store, adapter: new FakeAdapter(thread), thread,
    threadHash: gmailThreadStateHash(normalized) };
}

function message(input: {
  id: string; body: string; internalDate: string; labels?: string[];
}): GmailApiMessage {
  return {
    id: input.id, threadId: "thread1", internalDate: input.internalDate,
    labelIds: input.labels ?? ["IMPORTANT", "INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: input.labels?.includes("SENT")
          ? "Taylor <user@example.com>" : "Thompson Tee Support <help@example.com>" },
        { name: "To", value: input.labels?.includes("SENT")
          ? "Thompson Tee Support <help@example.com>" : "Taylor <user@example.com>" },
        { name: "Subject", value: "Coupon code" },
        { name: "Message-ID", value: `<${input.id}@example.com>` },
      ],
      body: { data: Buffer.from(input.body).toString("base64url") },
    },
  };
}

class FakeAdapter implements GmailSourceAdapter {
  constructor(readonly thread: GmailApiThread) {}
  async listSelectedMessageIds(): Promise<{ messageIds: string[] }> { return { messageIds: [] }; }
  async getMessage(): Promise<GmailApiMessage> { return this.thread.messages![0]!; }
  async getThread(): Promise<GmailApiThread> { return this.thread; }
  async getProfile(): Promise<{ emailAddress: string }> { return { emailAddress: "user@example.com" }; }
}
