import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VaultNote } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import { ChangeTracker } from "../src/state/change-tracker";
import { StateProjector } from "../src/state/projections";

function store(): OperationalStore {
  const result = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-state-")), "state.db"));
  result.migrate();
  return result;
}

function note(raw: string): VaultNote {
  return {
    path: "/vault/20 Projects/Life OS.md", relativePath: "20 Projects/Life OS.md",
    metadata: { type: "project", id: "project_lifeos", status: "active" },
    body: raw, raw, frontmatterErrors: [], title: "Life OS",
  };
}

test("project state is compact, source-grounded, and only versions changed input", () => {
  const db = store();
  const projector = new StateProjector(db);
  const first = projector.projectProject(note("# Life OS\n## Outcome\nReliable chief of staff\n## Next actions\n- [ ] Add context builder"));
  const unchanged = projector.projectProject(note("# Life OS\n## Outcome\nReliable chief of staff\n## Next actions\n- [ ] Add context builder"));
  const changed = projector.projectProject(note("# Life OS\n## Outcome\nReliable chief of staff\n## Next actions\n- [ ] Add model gateway"));

  expect(first.stateVersion).toBe(1);
  expect(unchanged.stateId).toBe(first.stateId);
  expect(changed.stateVersion).toBe(2);
  expect(db.countRows("derived_states")).toBe(2);
});

test("change tracker does not record unchanged source content", () => {
  const db = store();
  const tracker = new ChangeTracker(db);
  expect(tracker.track({ sourceType: "note", sourceId: "p1", content: "one" }).changed).toBe(true);
  expect(tracker.track({ sourceType: "note", sourceId: "p1", content: "one" }).changed).toBe(false);
  expect(tracker.track({ sourceType: "note", sourceId: "p1", content: "two" }).changed).toBe(true);
  expect(db.countRows("change_events")).toBe(2);
});
