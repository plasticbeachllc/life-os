import { expect, test } from "bun:test";
import type { IngestIntegration } from "../src/integrations/contract";
import { IntegrationRegistry } from "../src/integrations/registry";
import { gmailIngestionDetails } from "../src/integrations/providers";
import { runRegisteredIntegrationCommand } from "../src/cli/integration-commands";

const integration = (id: IngestIntegration["id"]): IngestIntegration => ({
  id,
  application: {
    cliCommand: id,
    statusTool: `life_os_${id}_status`,
    ingestTool: `life_os_ingest_${id}`,
  },
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

test("Gmail ingestion details exclude provider identifiers and raw errors", () => {
  const details = gmailIngestionDetails({ selector: "IMPORTANT", failures: [
    { messageId: "provider-message-123", error: "Gmail API request failed (429): private detail" },
    { messageId: "provider-message-456", error: "selected message no longer has IMPORTANT label" },
  ] });
  expect(details).toEqual({ selector: "IMPORTANT", partialFailures: 2,
    failureCategories: { provider_request_failed: 1, selection_changed: 1 } });
  expect(JSON.stringify(details)).not.toContain("provider-message");
  expect(JSON.stringify(details)).not.toContain("private detail");
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
  expect(() => registry.register({
    ...integration("unsafe"), capabilities: {
      ...integration("unsafe").capabilities, providerMutation: true as false,
    },
  })).toThrow("unsafe application registration");
});

test("registered CLI status and ingestion expose only bounded generated operations", async () => {
  let receivedLimit: number | undefined;
  let receivedVault: string | undefined;
  const gmail = {
    ...integration("gmail"),
    application: { ...integration("gmail").application, cliCommand: "email" },
  };
  gmail.limit = { default: 25, maximum: 100, description: "bounded" };
  gmail.status = ({ vaultPath } = {}) => {
    receivedVault = vaultPath;
    return integration("gmail").status();
  };
  gmail.ingest = async ({ limit, vaultPath }) => {
    receivedLimit = limit;
    receivedVault = vaultPath;
    return { provider: "gmail", sourceId: "source", runId: "run_test",
      counts: { discovered: 0, changed: 0, unchanged: 0, failed: 0, unavailableContent: 0 },
      modelCalls: 0, details: {} };
  };
  const registry = new IntegrationRegistry().register(gmail);
  const output: string[] = [];
  expect(await runRegisteredIntegrationCommand({
    command: "email", rest: ["ingest", "--limit", "80", "--vault", "/explicit/vault"], registry,
    write: (value) => output.push(value),
  })).toBe(0);
  expect(receivedLimit).toBe(80);
  expect(receivedVault).toBe("/explicit/vault");
  expect(Bun.env.LIFE_OS_VAULT_PATH).not.toBe("/explicit/vault");
  expect(JSON.parse(output[0]!).provider).toBe("gmail");
  await expect(runRegisteredIntegrationCommand({
    command: "email", rest: ["ingest", "--limit", "101"], registry,
  })).rejects.toThrow("between 1 and 100");
  await expect(runRegisteredIntegrationCommand({
    command: "email", rest: ["ingest", "--token", "secret"], registry,
  })).rejects.toThrow("unsupported integration flag");
  expect(await runRegisteredIntegrationCommand({
    command: "email", rest: ["auth"], registry,
  })).toBeUndefined();
  expect(await runRegisteredIntegrationCommand({
    command: "email", rest: ["status", "--vault", "/status/vault"], registry,
    write: (value) => output.push(value),
  })).toBe(0);
  expect(receivedVault).toBe("/status/vault");
});
