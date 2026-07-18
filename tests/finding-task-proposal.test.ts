import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ObsidianVault } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import { projectExtractionFindings } from "../src/findings/projector";
import { FindingStore } from "../src/findings/store";
import { applyFindingTaskProposal } from "../src/tools/append-finding-task";
import { proposeFindingTask } from "../src/workflows/finding-task-proposal";
import { prepareProposalAuthorization } from "../src/policy/authorization";
import { applyProposalWithAuthorization } from "../src/tools/apply-proposal";
import { undoAction } from "../src/tools/undo-action";
import { requireEffectPlan } from "../src/effects/contract";
import { findingUiId, proposeFindingTaskFromUi } from "../src/ui/finding-task";

test("an opaque browser finding identity can create only its fixed-inbox proposal", async () => {
  const { store, vault } = fixture();
  const finding = new FindingStore(store).review().findings
    .find((candidate) => candidate.statement === "First task")!;
  const review = await proposeFindingTaskFromUi({
    findingUiId: findingUiId(finding.findingId), store, vault,
  });
  expect(review).toMatchObject({ effectType: "finding_task_append", approval: "required",
    preview: "Add one task to your Inbox" });
  await expect(proposeFindingTaskFromUi({ findingUiId: "ui_0123456789abcdefabcd", store, vault }))
    .rejects.toThrow("not currently reviewable");
  expect(JSON.stringify(review)).not.toContain(finding.findingId);
});

test("multiple active findings create distinct fixed-inbox proposals idempotently", async () => {
  const { store, vault, root } = fixture();
  const findings = new FindingStore(store).review().findings;
  const firstFinding = findings.find((finding) => finding.statement === "First task")!;
  const secondFinding = findings.find((finding) => finding.statement === "Second task")!;
  const ineligibleFinding = findings.find((finding) => finding.statement === "Other person's task")!;

  const first = await proposeFindingTask({ findingId: firstFinding.findingId, store, vault });
  const firstReplay = await proposeFindingTask({ findingId: firstFinding.findingId, store, vault });
  const second = await proposeFindingTask({ findingId: secondFinding.findingId, store, vault });
  expect(firstReplay.proposalId).toBe(first.proposalId);
  expect(second.proposalId).not.toBe(first.proposalId);
  expect(first).toMatchObject({
    effectType: "finding_task_append", executorVersion: "finding-task-append-v1",
    sourceType: "finding",
    sourceId: firstFinding.findingId, targetPath: "00 Inbox/Inbox.md",
  });
  expect(requireEffectPlan(first, "finding_task_append").taskLine).toBe("- [ ] First task 📅 2026-07-15");
  expect(await Bun.file(join(root, "00 Inbox/Inbox.md")).text()).toBe("# Inbox\n");
  expect(store.listPendingProposals()).toHaveLength(2);
  await expect(proposeFindingTask({
    findingId: ineligibleFinding.findingId, store, vault,
  })).rejects.toThrow("user-owned actionable");
});

test("a finding changed after proposal creation is rejected before a vault write", async () => {
  const { store, vault, root } = fixture();
  const finding = new FindingStore(store).review().findings
    .find((candidate) => candidate.statement === "First task")!;
  const proposal = await proposeFindingTask({ findingId: finding.findingId, store, vault });
  new FindingStore(store).dismiss({
    findingId: finding.findingId, reason: "Reviewed as no longer needed",
    createdAt: "2026-07-12T13:00:00.000Z",
  });
  store.approveProposalAction(proposal.proposalId, proposal.actionId, "2026-07-12T13:01:00.000Z");
  await expect(prepareProposalAuthorization({
    proposalId: proposal.proposalId, store, vault,
  })).rejects.toThrow("finding changed");
  await expect(applyFindingTaskProposal({
    proposalId: proposal.proposalId, store, vault, backupRoot: join(root, "backups"),
  })).rejects.toThrow("finding changed");
  expect(await Bun.file(join(root, "00 Inbox/Inbox.md")).text()).toBe("# Inbox\n");
  expect(store.getProposal(proposal.proposalId)?.lifecycleState).toBe("approved");
});

test("authorized finding task conversion is atomic with action state and reversible on undo", async () => {
  const { store, vault, root } = fixture();
  const finding = new FindingStore(store).review().findings
    .find((candidate) => candidate.statement === "First task")!;
  const proposal = await proposeFindingTask({ findingId: finding.findingId, store, vault });
  const authorization = await prepareProposalAuthorization({
    proposalId: proposal.proposalId, store, vault,
  });
  const applied = await applyProposalWithAuthorization({
    token: authorization.token, proposalId: proposal.proposalId, actionId: proposal.actionId,
    store, vault, backupRoot: join(root, "backups"),
  });
  expect(store.getProposal(proposal.proposalId)?.lifecycleState).toBe("applied");
  expect(new FindingStore(store).get(finding.findingId)?.status).toBe("converted");
  expect(await Bun.file(join(root, "00 Inbox/Inbox.md")).text()).toContain("First task");

  await undoAction({ actionId: applied.actionId, store, vault });
  expect(new FindingStore(store).get(finding.findingId)?.status).toBe("active");
  expect(await Bun.file(join(root, "00 Inbox/Inbox.md")).text()).toBe("# Inbox\n");
});

test("a post-write recording failure restores the inbox and leaves the finding active", async () => {
  const { store, vault, root } = fixture();
  const finding = new FindingStore(store).review().findings
    .find((candidate) => candidate.statement === "First task")!;
  const proposal = await proposeFindingTask({ findingId: finding.findingId, store, vault });
  store.approveProposalAction(proposal.proposalId, proposal.actionId, "2026-07-12T13:00:00.000Z");
  store.markProposalApplied = () => { throw new Error("simulated recording failure"); };
  await expect(applyFindingTaskProposal({
    proposalId: proposal.proposalId, store, vault, backupRoot: join(root, "backups"),
  })).rejects.toThrow("simulated recording failure");
  expect(await Bun.file(join(root, "00 Inbox/Inbox.md")).text()).toBe("# Inbox\n");
  expect(new FindingStore(store).get(finding.findingId)?.status).toBe("active");
  expect(store.getProposal(proposal.proposalId)?.lifecycleState).toBe("approved");
});

function fixture(): { store: OperationalStore; vault: ObsidianVault; root: string } {
  const root = mkdtempSync(join(tmpdir(), "life-os-finding-task-"));
  mkdirSync(join(root, "00 Inbox"), { recursive: true });
  mkdirSync(join(root, "90 System/AI"), { recursive: true });
  writeFileSync(join(root, "00 Inbox/Inbox.md"), "# Inbox\n");
  for (const file of ["Constitution.md", "Permissions.md", "Schemas.md", "Agent.md"]) {
    writeFileSync(join(root, "90 System/AI", file), `# ${file}\n`);
  }
  writeFileSync(join(root, "90 System/AI/permissions.toml"),
    "[actions.create_task]\nenabled = true\nmode = \"proposal\"\n");
  const store = new OperationalStore(join(root, "store.db"));
  store.migrate();
  store.recordModelCall({
    callId: "call_finding_tasks", workflow: "gmail_extraction",
    taskType: "subscription_email_extraction", model: "test", promptVersion: "v1",
    sourceHash: "sha256:source", contextHash: "sha256:context", cached: false,
    startedAt: "2026-07-12T12:00:00.000Z", completedAt: "2026-07-12T12:00:01.000Z",
    status: "completed",
  });
  projectExtractionFindings({
    store,
    extraction: {
      sourceType: "gmail_extraction", extractionId: "extract_finding_tasks",
      callId: "call_finding_tasks", createdAt: "2026-07-12T12:00:01.000Z",
      output: { items: [
        { kind: "open_loop", statement: "First task", owner: "user", dueDate: "2026-07-15",
          confidence: 1, ambiguities: [], evidenceIds: ["gmail:m1:sha256:one"] },
        { kind: "explicit_request", statement: "Second task", owner: "user", dueDate: null,
          confidence: 1, ambiguities: [], evidenceIds: ["gmail:m2:sha256:two"] },
        { kind: "open_loop", statement: "Other person's task", owner: "other", dueDate: null,
          confidence: 1, ambiguities: [], evidenceIds: ["gmail:m3:sha256:three"] },
      ] },
    },
  });
  return { store, vault: new ObsidianVault(root), root };
}
