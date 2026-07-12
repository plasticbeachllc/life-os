import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ObsidianVault } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import {
  consumeUndoAuthorization,
  prepareProposalAuthorization,
  prepareUndoAuthorization,
} from "../src/policy/authorization";
import { applyProposalWithAuthorization } from "../src/tools/apply-proposal";
import { undoAction } from "../src/tools/undo-action";
import { proposeMetadataNormalization } from "../src/workflows/normalize-metadata";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function fixture(): {
  vault: ObsidianVault; store: OperationalStore; backupRoot: string;
  firstPath: string; secondPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "life-os-auth-"));
  const firstPath = join(root, "30 People/First.md");
  const secondPath = join(root, "30 People/Second.md");
  write(firstPath, "---\nlast_contact:\n---\n# First\n");
  write(secondPath, "---\nlast_contact:\n---\n# Second\n");
  for (const file of ["Constitution.md", "Permissions.md", "Schemas.md", "Agent.md"]) {
    write(join(root, "90 System/AI", file), `# ${file}\n`);
  }
  write(join(root, "90 System/AI/permissions.toml"), `[actions.apply_frontmatter_patch]\nenabled = true\nmode = "proposal"\n`);
  return {
    vault: new ObsidianVault(root),
    store: new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-auth-db-")), "store.db")),
    backupRoot: mkdtempSync(join(tmpdir(), "life-os-auth-backup-")), firstPath, secondPath,
  };
}

test("authorization rejects wrong, expired, cross-action, and stale tokens without writes", async () => {
  const context = fixture();
  const proposals = (await proposeMetadataNormalization(context)).created;
  const first = proposals.find((proposal) => proposal.targetPath.endsWith("First.md"))!;
  const second = proposals.find((proposal) => proposal.targetPath.endsWith("Second.md"))!;
  const originalFirst = await Bun.file(context.firstPath).text();
  const originalSecond = await Bun.file(context.secondPath).text();

  const authorization = await prepareProposalAuthorization({ ...context, proposalId: first.proposalId });
  expect(applyProposalWithAuthorization({
    ...context, token: "confirm_wrong", proposalId: first.proposalId, actionId: first.actionId,
  })).rejects.toThrow("invalid");
  expect(await Bun.file(context.firstPath).text()).toBe(originalFirst);

  expect(applyProposalWithAuthorization({
    ...context, token: authorization.token, proposalId: second.proposalId, actionId: second.actionId,
  })).rejects.toThrow("does not match");
  expect(await Bun.file(context.secondPath).text()).toBe(originalSecond);

  const expired = await prepareProposalAuthorization({ ...context, proposalId: first.proposalId, ttlSeconds: -1 });
  expect(applyProposalWithAuthorization({
    ...context, token: expired.token, proposalId: first.proposalId, actionId: first.actionId,
  })).rejects.toThrow("expired");

  const stale = await prepareProposalAuthorization({ ...context, proposalId: first.proposalId });
  write(context.firstPath, `${originalFirst}\nConcurrent edit.\n`);
  expect(applyProposalWithAuthorization({
    ...context, token: stale.token, proposalId: first.proposalId, actionId: first.actionId,
  })).rejects.toThrow("target changed");
  expect(context.store.getProposal(first.proposalId)?.approved).toBe(false);
});

test("authorization applies once and requires a separately bound token for undo", async () => {
  const context = fixture();
  const proposal = (await proposeMetadataNormalization(context)).created[0]!;
  const authorization = await prepareProposalAuthorization({ ...context, proposalId: proposal.proposalId });
  await applyProposalWithAuthorization({
    ...context, token: authorization.token, proposalId: proposal.proposalId, actionId: proposal.actionId,
  });
  expect(await Bun.file(context.vault.path(proposal.targetPath)).text()).toContain("type: person");
  expect(applyProposalWithAuthorization({
    ...context, token: authorization.token, proposalId: proposal.proposalId, actionId: proposal.actionId,
  })).rejects.toThrow("cannot be applied");

  const undo = await prepareUndoAuthorization({ ...context, actionId: proposal.actionId });
  expect(consumeUndoAuthorization({ ...context, token: "confirm_wrong", actionId: proposal.actionId })).rejects.toThrow("invalid");
  await consumeUndoAuthorization({ ...context, token: undo.token, actionId: proposal.actionId });
  await undoAction({ ...context, actionId: proposal.actionId });
  expect(await Bun.file(context.vault.path(proposal.targetPath)).text()).not.toContain("type: person");
  expect(consumeUndoAuthorization({ ...context, token: undo.token, actionId: proposal.actionId })).rejects.toThrow("active undo record not found");
});

test("red proposals can never receive an authorization token", async () => {
  const context = fixture();
  context.store.migrate();
  const createdAt = new Date().toISOString();
  const proposal = context.store.createProposal({
    proposalId: "prop_red", runId: "run_red", actionId: "act_red", workflow: "test",
    sourceType: "user", sourceId: "test", sourceHash: "missing",
    targetPath: "30 People/First.md", targetHash: "missing", toolName: "delete_note",
    permissionClass: "red", arguments: { preview: "delete" }, createdAt,
  });
  expect(prepareProposalAuthorization({ ...context, proposalId: proposal.proposalId })).rejects.toThrow("red action");
});
