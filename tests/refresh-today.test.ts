import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ObsidianVault } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import { IntegrationRegistry } from "../src/integrations/registry";
import { refreshToday } from "../src/workflows/refresh-today";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

test("Today refresh ingests only enabled read-only providers, isolates failures, and rebuilds state", async () => {
  const root = mkdtempSync(join(tmpdir(), "life-os-refresh-today-"));
  write(join(root, "20 Projects/Today.md"), `---
type: project
id: project_today
status: active
---
# Today

## Outcome
Use one trusted daily queue

## Next actions
- [ ] Review the queue
  <!-- life-os:task_id=task_reviewqueue -->
`);
  const store = new OperationalStore(join(root, "state.db"));
  let ingested = 0;
  const registry = new IntegrationRegistry()
    .register({
      id: "enabled", capabilities: { ingestion: true, immutableVersions: true,
        transientRefetch: false, extraction: false, providerMutation: false },
      application: { cliCommand: "enabled", statusTool: "life_os_enabled_status", ingestTool: "life_os_ingest_enabled" },
      statusDescription: "", ingestDescription: "", limit: { default: 1, maximum: 1, description: "" },
      status: () => ({ provider: "enabled", sourceId: "primary", enabled: true,
        capabilities: { ingestion: true, immutableVersions: true, transientRefetch: false, extraction: false, providerMutation: false }, details: {} }),
      ingest: async () => {
        ingested += 1;
        return { provider: "enabled", sourceId: "primary", runId: "run", modelCalls: 0 as const,
          counts: { discovered: 1, changed: 1, unchanged: 0, failed: 0, unavailableContent: 0 }, details: {} };
      },
    })
    .register({
      id: "disabled", capabilities: { ingestion: true, immutableVersions: true,
        transientRefetch: false, extraction: false, providerMutation: false },
      application: { cliCommand: "disabled", statusTool: "life_os_disabled_status", ingestTool: "life_os_ingest_disabled" },
      statusDescription: "", ingestDescription: "",
      status: () => ({ provider: "disabled", sourceId: "primary", enabled: false,
        capabilities: { ingestion: true, immutableVersions: true, transientRefetch: false, extraction: false, providerMutation: false }, details: {} }),
      ingest: async () => { throw new Error("disabled providers must not ingest"); },
    })
    .register({
      id: "failing", capabilities: { ingestion: true, immutableVersions: true,
        transientRefetch: false, extraction: false, providerMutation: false },
      application: { cliCommand: "failing", statusTool: "life_os_failing_status", ingestTool: "life_os_ingest_failing" },
      statusDescription: "", ingestDescription: "",
      status: () => { throw new Error("private provider failure"); },
      ingest: async () => { throw new Error("unreachable"); },
    });

  const report = await refreshToday({ vault: new ObsidianVault(root), store, vaultPath: root, registry,
    now: new Date("2026-07-13T12:00:00.000Z") });

  expect(ingested).toBe(1);
  expect(report).toMatchObject({ modelCalls: 0, state: { projected: 2 } });
  expect(report.providers).toEqual([
    { provider: "enabled", status: "ingested", changed: 1, unchanged: 0 },
    { provider: "disabled", status: "disabled", changed: 0, unchanged: 0 },
    { provider: "failing", status: "failed", changed: 0, unchanged: 0 },
  ]);
  expect(JSON.stringify(report)).not.toContain("private provider failure");
  expect(store.countRows("model_calls")).toBe(0);
});
