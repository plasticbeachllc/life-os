import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

import { ObsidianVault } from "../adapters/obsidian";
import { loadConfig } from "../config";
import { OperationalStore, type ProposalRecord } from "../db/store";
import { reviewEffectProposal } from "../effects/registry";
import {
  consumeUndoAuthorization, prepareProposalAuthorization, prepareUndoAuthorization,
} from "../policy/authorization";
import { applyProposalWithAuthorization } from "../tools/apply-proposal";
import { undoAction } from "../tools/undo-action";
import { proposeFindingTask } from "../workflows/finding-task-proposal";

export function registerProposalTools(server: McpServer): void {
  server.registerTool("life_os_list_pending_proposals", {
    description: "List pending or approved Life OS proposals in a sanitized review form. Does not approve or apply anything.",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false },
  }, async () => {
    const { store } = runtime();
    const proposals = store.listPendingProposals().map(sanitizeProposal);
    return jsonResult({ count: proposals.length, proposals });
  });

  server.registerTool("life_os_propose_finding_task", {
    description: "Create one approval-gated fixed-inbox task proposal from an active user-owned actionable finding. The caller cannot supply task text, due date, ID, or path; this does not write the vault.",
    inputSchema: { findingId: z.string().startsWith("finding_") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ findingId }) => {
    const context = runtime();
    return jsonResult(sanitizeProposal(await proposeFindingTask({ findingId, ...context })));
  });

  server.registerTool("life_os_get_proposal", {
    description: "Get one proposal's sanitized review details and exact preview. Does not approve or apply it.",
    inputSchema: { proposalId: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ proposalId }) => {
    const proposal = runtime().store.getProposal(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    return jsonResult(sanitizeProposal(proposal));
  });

  server.registerTool("life_os_prepare_proposal_approval", {
    description: "Revalidate one exact proposal and issue a short-lived, single-use confirmation token bound to its action and target hash. Does not apply the proposal.",
    inputSchema: { proposalId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ proposalId }) => jsonResult(await prepareProposalAuthorization({ proposalId, ...runtime() })));

  server.registerTool("life_os_apply_approved_proposal", {
    description: "Apply only the exact proposal/action authorized by a short-lived confirmation token. Accepts no path, patch, or arbitrary action arguments.",
    inputSchema: {
      proposalId: z.string().min(1), actionId: z.string().min(1), confirmationToken: z.string().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ proposalId, actionId, confirmationToken }) => {
    const context = runtime();
    return jsonResult(await applyProposalWithAuthorization({
      token: confirmationToken, proposalId, actionId, ...context,
      backupRoot: context.config.backupPath,
    }));
  });

  server.registerTool("life_os_prepare_undo", {
    description: "Revalidate an applied action's current target and issue a short-lived, single-use undo token. Does not modify the vault.",
    inputSchema: { actionId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ actionId }) => jsonResult(await prepareUndoAuthorization({ actionId, ...runtime() })));

  server.registerTool("life_os_undo_action", {
    description: "Undo only the exact action authorized by a short-lived confirmation token, if the target still matches the applied hash.",
    inputSchema: { actionId: z.string().min(1), confirmationToken: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ actionId, confirmationToken }) => {
    const context = runtime();
    await consumeUndoAuthorization({ token: confirmationToken, actionId, ...context });
    return jsonResult(await undoAction({ actionId, ...context }));
  });
}

function runtime(): {
  config: ReturnType<typeof loadConfig>; vault: ObsidianVault; store: OperationalStore;
} {
  const config = loadConfig();
  const store = new OperationalStore(config.databasePath); store.migrate();
  return { config, vault: new ObsidianVault(config.vaultPath), store };
}

export function sanitizeProposal(proposal: ProposalRecord): Record<string, unknown> {
  const review = reviewEffectProposal(proposal);
  return {
    proposalId: proposal.proposalId, actionId: proposal.actionId,
    workflow: proposal.workflow, lifecycleState: proposal.lifecycleState,
    permissionClass: proposal.permissionClass, effectType: proposal.effectType,
    executorVersion: proposal.executorVersion, targetPath: proposal.targetPath,
    expectedTargetHash: proposal.targetHash, preview: review.preview,
    createdAt: proposal.createdAt, expiresAt: proposal.expiresAt ?? null,
    approved: proposal.approved,
  };
}

function jsonResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
