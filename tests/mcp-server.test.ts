import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createLifeOsMcpServer } from "../src/mcp/server";

test("MCP server handshakes and exposes only narrow Life OS tools", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createLifeOsMcpServer();
  const client = new Client({ name: "life-os-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "life_os_apply_approved_proposal",
      "life_os_calendar_status",
      "life_os_doctor",
      "life_os_get_morning_briefing",
      "life_os_get_proposal",
      "life_os_gmail_status",
      "life_os_ingest_calendar",
      "life_os_list_compact_state",
      "life_os_list_pending_proposals",
      "life_os_prepare_email_extraction",
      "life_os_prepare_morning_reasoning",
      "life_os_prepare_proposal_approval",
      "life_os_prepare_undo",
      "life_os_preview_email_extraction_context",
      "life_os_propose_email_task",
      "life_os_rebuild_state",
      "life_os_review_email_extractions",
      "life_os_submit_email_extraction",
      "life_os_submit_morning_reasoning",
      "life_os_undo_action",
    ]);
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri).sort()).toEqual([
      "life-os://policy/schemas",
      "life-os://workflows/morning",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
