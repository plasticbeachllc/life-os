import { expect, test } from "bun:test";
import type { IngestIntegration } from "../src/integrations/contract";
import { IntegrationRegistry } from "../src/integrations/registry";

const integration = (id: IngestIntegration["id"]): IngestIntegration => ({
  id,
  capabilities: {
    ingestion: true, immutableVersions: true, transientRefetch: false,
    extraction: false, providerMutation: false,
  },
  statusDescription: `${id} status`, ingestDescription: `${id} ingest`,
  status: () => ({ provider: id, sourceId: "source", enabled: true,
    capabilities: {
      ingestion: true, immutableVersions: true, transientRefetch: false,
      extraction: false, providerMutation: false,
    }, details: {} }),
  ingest: async () => ({ provider: id, sourceId: "source", runId: "run_test",
    counts: { discovered: 0, changed: 0, unchanged: 0, failed: 0, unavailableContent: 0 },
    modelCalls: 0, details: {} }),
});

test("integration registry preserves registration order and rejects duplicate providers", () => {
  const registry = new IntegrationRegistry()
    .register(integration("gmail"))
    .register(integration("calendar"));
  expect(registry.list().map((item) => item.id)).toEqual(["gmail", "calendar"]);
  expect(registry.get("gmail").capabilities.providerMutation).toBe(false);
  expect(() => registry.register(integration("gmail"))).toThrow("duplicate integration");
  expect(() => registry.get("telegram")).toThrow("not registered");
  expect(() => registry.register(integration("Invalid Provider"))).toThrow("invalid integration identifier");
});
