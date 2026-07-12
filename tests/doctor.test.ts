import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ObsidianVault } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import { runDoctor } from "../src/workflows/doctor";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function makeVault(): { vaultPath: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "life-os-vault-"));
  for (const folder of [
    "00 Inbox",
    "10 Journal/2026",
    "20 Projects",
    "30 People",
    "40 Planning",
    "90 System/AI",
  ]) {
    mkdirSync(join(root, folder), { recursive: true });
  }

  write(join(root, "90 System/AI/Constitution.md"), "# Constitution\n");
  write(join(root, "90 System/AI/Permissions.md"), "# Permissions\n");
  write(join(root, "90 System/AI/Schemas.md"), "# Schemas\n");
  write(join(root, "90 System/AI/Agent.md"), "# Agent\n");
  write(join(root, "90 System/AI/permissions.toml"), "[actions]\n");
  write(join(root, "00 Inbox/Inbox.md"), "# Inbox\n");
  write(
    join(root, "30 People/Ada Lovelace.md"),
    `---
type: person
id: person_abcdef123456
last_contact: 2026-07-11
---
# Ada Lovelace

## Context

## Interaction log
### 2026-07-11 - Email
Source: user:test
`,
  );
  write(
    join(root, "20 Projects/Analytical Engine.md"),
    `---
type: project
id: project_abcdef123456
status: active
---
# Analytical Engine

## Outcome
Working prototype

## Next actions
- [ ] Draft plan
`,
  );

  const dbPath = join(mkdtempSync(join(tmpdir(), "life-os-store-")), "life-os.db");
  new OperationalStore(dbPath).migrate();
  return { vaultPath: root, dbPath };
}

test("doctor validates revised mandatory policy files and database", async () => {
  const { vaultPath, dbPath } = makeVault();

  const report = await runDoctor({
    vault: new ObsidianVault(vaultPath),
    store: new OperationalStore(dbPath),
  });

  expect(report.errorCount).toBe(0);
  expect(report.findings.map((finding) => finding.message)).toContain(
    "operational database schema found",
  );
  expect(report.findings.map((finding) => finding.message)).toContain(
    "policy document found: permissionsToml",
  );
});

test("doctor fails closed when revised policy file is missing", async () => {
  const { vaultPath, dbPath } = makeVault();
  unlinkSync(join(vaultPath, "90 System/AI/permissions.toml"));

  const report = await runDoctor({
    vault: new ObsidianVault(vaultPath),
    store: new OperationalStore(dbPath),
  });

  expect(report.errorCount).toBeGreaterThan(0);
  expect(report.findings).toContainEqual({
    severity: "error",
    message: "mandatory policy document missing: permissionsToml",
    detail: "90 System/AI/permissions.toml",
  });
});
