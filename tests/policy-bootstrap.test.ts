import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ObsidianVault } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import { compileActionPolicy, loadPolicy, parsePermissions } from "../src/policy/loader";
import { applyPolicyBootstrapProposal } from "../src/tools/bootstrap-policy-file";
import { undoAction } from "../src/tools/undo-action";
import { proposePolicyBootstrap } from "../src/workflows/bootstrap-policy";
import { applyPolicyBootstrapSet, pendingPolicyBootstrapSet } from "../src/workflows/apply-policy-bootstrap-set";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function fixture(): { vault: ObsidianVault; store: OperationalStore; backupRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "life-os-policy-"));
  write(join(root, "90 System/AI/Agent Constitution.md"), "# Existing constitution\n");
  write(join(root, "90 System/AI/Agent Permissions.md"), "# Existing permissions\n");
  write(join(root, "90 System/AI/Chief of Staff Agent.md"), "# Existing agent\n");
  const store = new OperationalStore(join(mkdtempSync(join(tmpdir(), "life-os-policy-db-")), "store.db"));
  return {
    vault: new ObsidianVault(root), store,
    backupRoot: mkdtempSync(join(tmpdir(), "life-os-policy-backups-")),
  };
}

test("permissions parser rejects contradictory configuration", () => {
  expect(() => parsePermissions(`[actions.write]\nenabled = false\nmode = "proposal"\n`)).toThrow("contradictory");
});

test("bootstrap creates selective proposals and produces compilable policy", async () => {
  const { vault, store, backupRoot } = fixture();
  const report = await proposePolicyBootstrap({ vault, store });
  expect(report.created).toHaveLength(5);
  expect((await proposePolicyBootstrap({ vault, store })).existing).toHaveLength(5);

  for (const proposal of report.created) {
    store.approveProposalAction(proposal.proposalId, proposal.actionId, new Date().toISOString());
    await applyPolicyBootstrapProposal({ proposalId: proposal.proposalId, vault, store, backupRoot });
  }
  const policy = await loadPolicy(vault);
  expect(policy.missing).toEqual({});
  expect(policy.errors).toEqual([]);
  expect(compileActionPolicy(policy, "apply_frontmatter_patch").requiresApproval).toBe(true);

  const schemas = report.created.find((proposal) => proposal.targetPath.endsWith("Schemas.md"))!;
  await undoAction({ actionId: schemas.actionId, vault, store });
  expect(existsSync(vault.path("90 System/AI/Schemas.md"))).toBe(false);
});

test("bootstrap rejects changed source policy", async () => {
  const { vault, store, backupRoot } = fixture();
  const proposal = (await proposePolicyBootstrap({ vault, store })).created.find((item) => item.targetPath.endsWith("Constitution.md"))!;
  store.approveProposalAction(proposal.proposalId, proposal.actionId, new Date().toISOString());
  write(vault.path("90 System/AI/Agent Constitution.md"), "# Changed constitution\n");
  expect(applyPolicyBootstrapProposal({ proposalId: proposal.proposalId, vault, store, backupRoot })).rejects.toThrow("source changed");
});

test("batch bootstrap requires the exact pending-set token", async () => {
  const { vault, store, backupRoot } = fixture();
  await proposePolicyBootstrap({ vault, store });
  const set = pendingPolicyBootstrapSet(store);
  expect(set.proposals).toHaveLength(5);

  expect(applyPolicyBootstrapSet({
    confirmationToken: "bootstrap_wrong", vault, store, backupRoot,
  })).rejects.toThrow("does not match");
  expect(store.countRows("approvals")).toBe(0);

  const result = await applyPolicyBootstrapSet({
    confirmationToken: set.confirmationToken, vault, store, backupRoot,
  });
  expect(result.applied).toHaveLength(5);
  expect(store.countRows("approvals")).toBe(5);
  expect((await loadPolicy(vault)).errors).toEqual([]);
});
