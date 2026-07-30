import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ObsidianVault } from "../src/adapters/obsidian";
import { OperationalStore } from "../src/db/store";
import { projectExtractionFindings } from "../src/findings/projector";
import { FindingStore } from "../src/findings/store";
import { prepareProposalAuthorization } from "../src/policy/authorization";
import { applyProposalWithAuthorization } from "../src/tools/apply-proposal";
import {
  actionUiId,
  proposeAttentionTaskFromUi,
  requirePendingTaskProposalFromUi,
  requireUndoableTaskActionFromUi,
} from "../src/ui/browser-actions";
import { attentionSubjectUiId } from "../src/ui/feedback";

test("opaque attention, proposal, and action identities drive only one fixed task workflow", async () => {
  const { store, vault, root, findingId, attentionUiId } = fixture();
  const review = await proposeAttentionTaskFromUi({ attentionUiId, store, vault });
  expect(review.id).toMatch(/^ui_[a-f0-9]{20}$/);
  expect(review).toMatchObject({
    effectType: "finding_task_append",
    approval: "required",
    preview: "First task 📅 2026-07-15",
  });
  expect(JSON.stringify(review)).not.toContain(findingId);

  const proposal = requirePendingTaskProposalFromUi({ proposalUiId: review.id, store });
  expect(() => requirePendingTaskProposalFromUi({
    proposalUiId: "ui_0123456789abcdefabcd", store,
  })).toThrow("not currently reviewable");
  const authorization = await prepareProposalAuthorization({
    proposalId: proposal.proposalId, store, vault,
  });
  await applyProposalWithAuthorization({
    token: authorization.token,
    proposalId: proposal.proposalId,
    actionId: proposal.actionId,
    store,
    vault,
    backupRoot: join(root, "backups"),
  });
  const action = requireUndoableTaskActionFromUi({
    actionUiId: actionUiId(proposal.actionId),
    store,
  });
  expect(action.actionId).toBe(proposal.actionId);
  expect(action.proposal.effectType).toBe("finding_task_append");
  expect(() => requireUndoableTaskActionFromUi({
    actionUiId: "ui_ffffffffffffffffffff", store,
  })).toThrow("not currently undoable");
});

test("task proposal rejects stale attention and non-singular intervention targets", async () => {
  const { store, vault, attentionUiId } = fixture();
  const state = store.getCurrentDerivedState("finding_attention_state")!;
  store.saveDerivedState({
    ...state,
    stateId: "state_attention_replaced",
    stateVersion: state.stateVersion + 1,
    content: { ...state.content, signals: [], presentation: [] },
    dependencyHash: "sha256:replacement",
  });
  await expect(proposeAttentionTaskFromUi({ attentionUiId, store, vault }))
    .rejects.toThrow("does not have a ready task intervention");
});

function fixture(): {
  store: OperationalStore;
  vault: ObsidianVault;
  root: string;
  findingId: string;
  attentionUiId: string;
} {
  const root = mkdtempSync(join(tmpdir(), "life-os-browser-actions-"));
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
    callId: "call_browser_action", workflow: "gmail_extraction",
    taskType: "subscription_email_extraction", model: "test", promptVersion: "v1",
    sourceHash: "sha256:source", contextHash: "sha256:context", cached: false,
    startedAt: "2026-07-12T12:00:00.000Z", completedAt: "2026-07-12T12:00:01.000Z",
    status: "completed",
  });
  projectExtractionFindings({
    store,
    extraction: {
      sourceType: "gmail_extraction",
      extractionId: "extract_browser_action",
      callId: "call_browser_action",
      createdAt: "2026-07-12T12:00:01.000Z",
      output: { items: [{
        kind: "open_loop",
        statement: "First task",
        owner: "user",
        dueDate: "2026-07-15",
        confidence: 1,
        ambiguities: [],
        evidenceIds: ["gmail:m1:sha256:one"],
      }] },
    },
  });
  const findingId = new FindingStore(store).review().findings[0]!.findingId;
  const presentation = {
    attention_id: "attention_browser_task",
    channel: "review_queue",
    reason: "reviewable_intervention",
    explanation: "A bounded task can be reviewed.",
    policy_version: "attention-presentation-v1",
  } as const;
  store.saveDerivedState({
    stateId: "state_browser_attention",
    stateType: "finding_attention_state",
    stateVersion: 1,
    content: {
      as_of: "2026-07-12T12:00:00.000Z",
      signals: [{
        attention_id: presentation.attention_id,
        type: "untracked_user_commitment",
        title: "Commitment is not tracked",
        summary: "First task",
        finding_ids: [findingId],
        subject_refs: [],
        owner: "user",
        confidence: 1,
        impact: "medium",
        urgency: "soon",
        due_date: "2026-07-15",
        explanation: "No matching task exists.",
        ambiguities: [],
        suggested_interventions: [{
          kind: "create_task",
          rationale: "Track it.",
          expected_benefit: "Include it in planning.",
          consequence_of_delay: null,
          permission_class: "yellow",
          readiness: "ready",
          reversible: true,
        }],
      }],
      presentation: [presentation],
    },
    sourceHashes: ["sha256:attention"],
    generationMethod: "test",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
  return {
    store,
    vault: new ObsidianVault(root),
    root,
    findingId,
    attentionUiId: attentionSubjectUiId({
      attentionId: presentation.attention_id,
      presentationChannel: presentation.channel,
      presentationReason: presentation.reason,
      policyVersion: presentation.policy_version,
    }),
  };
}
