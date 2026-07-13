import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../src/db/store";
import { parseUiFeedback, recordUiFeedback } from "../src/ui/feedback";

test("UI feedback accepts only opaque subjects and domain-specific outcomes", () => {
  expect(parseUiFeedback({
    subjectKind: "finding", subjectUiId: "ui_0123456789abcdefabcd", outcome: "useful",
  })).toEqual({ subjectKind: "finding", subjectUiId: "ui_0123456789abcdefabcd", outcome: "useful" });
  expect(() => parseUiFeedback({
    subjectKind: "finding", subjectUiId: "provider-message-id", outcome: "useful",
  })).toThrow("invalid feedback");
  expect(() => parseUiFeedback({
    subjectKind: "proposal", subjectUiId: "ui_0123456789abcdefabcd", outcome: "useful",
  })).toThrow("proposal feedback outcome");
});

test("UI feedback persists no provider or source payload", () => {
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-feedback-")), "store.db"));
  store.migrate();
  recordUiFeedback({ store, value: {
    subjectKind: "proposal", subjectUiId: "ui_0123456789abcdefabcd", outcome: "accepted",
  } });
  const db = store.open();
  try {
    const serialized = JSON.stringify(db.query("SELECT * FROM ui_feedback").all());
    expect(serialized).toContain("accepted");
    expect(serialized).not.toContain("provider");
    expect(serialized).not.toContain("sha256:");
  } finally { db.close(); }
});
