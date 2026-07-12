import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { IntegrationRegistry } from "../integrations/registry";

export function registerIntegrationTools(server: McpServer, registry: IntegrationRegistry): void {
  for (const integration of registry.list()) {
    server.registerTool(`life_os_${integration.id}_status`, {
      description: integration.statusDescription,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => jsonResult(await integration.status()));

    const inputSchema = integration.limit
      ? { limit: z.number().int().min(1).max(integration.limit.maximum).default(integration.limit.default)
        .describe(integration.limit.description) }
      : {};
    server.registerTool(`life_os_ingest_${integration.id}`, {
      description: integration.ingestDescription,
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async (input: Record<string, unknown>) => jsonResult(await integration.ingest({
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    })));
  }
}

function jsonResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
