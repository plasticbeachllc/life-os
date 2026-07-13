import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ObsidianVault } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import { rebuildState } from "../src/workflows/rebuild-state";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function fixture(): { vault: ObsidianVault; store: OperationalStore; projectPath: string } {
  const root = mkdtempSync(join(tmpdir(), "life-os-rebuild-"));
  const projectPath = join(root, "20 Projects/Life OS.md");
  write(projectPath, `---
type: project
id: project_life_os
status: active
---
# Life OS

## Outcome
Reliable chief of staff

## Next actions
- [ ] Build state
  <!-- life-os:task_id=task_buildstate -->
`);
  write(join(root, "30 People/Valid Person.md"), `---
type: person
id: person_valid
last_contact: 2026-07-12
---
# Valid Person

## Interaction log
Discussed architecture.
`);
  write(join(root, "30 People/Missing ID.md"), `---
type: person
---
# Missing ID
`);
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-rebuild-db-")), "state.db"));
  return { vault: new ObsidianVault(root), store, projectPath };
}

test("state rebuild processes deltas and repeatedly reports invalid notes", async () => {
  const { vault, store, projectPath } = fixture();

  const first = await rebuildState({ vault, store });
  expect(first.scanned).toBe(3);
  expect(first.projected).toBe(3);
  expect(first.issues).toEqual([{ path: "30 People/Missing ID.md", message: "canonical entity id required" }]);

  const second = await rebuildState({ vault, store });
  expect(second.changed).toBe(0);
  expect(second.unchanged).toBe(2);
  expect(second.issues).toHaveLength(1);

  write(projectPath, (await Bun.file(projectPath).text()).replace("Build state", "Build briefing"));
  const third = await rebuildState({ vault, store });
  expect(third.changed).toBe(1);
  expect(third.projected).toBe(2);
  expect(store.countRows("change_events")).toBe(3);
  expect(store.countRows("derived_states")).toBe(8);
});
