import { expect, test } from "bun:test";

import { effectPlanHash, parseEffectPlan } from "../src/effects/contract";
import {
  registeredEffectTypes, reviewEffectProposal,
} from "../src/effects/registry";
import type { ProposalRecord } from "../src/db/store";

test("the effect registry is closed over the four supported effect families", () => {
  expect(registeredEffectTypes()).toEqual([
    "finding_task_append", "frontmatter_patch", "policy_bootstrap", "task_id_patch",
  ]);
  expect(() => parseEffectPlan({ type: "shell", command: "rm -rf /" }))
    .toThrow("not registered");
  expect(() => parseEffectPlan({
    type: "frontmatter_patch", additions: { type: "person" }, path: "/tmp/escape",
  })).toThrow("unknown fields");
});

test("review verifies immutable plan identity and the current executor version", () => {
  const plan = { type: "frontmatter_patch" as const, additions: { type: "person" } };
  const proposal = proposalFor(plan);
  expect(reviewEffectProposal(proposal)).toEqual({
    effectType: "frontmatter_patch",
    executorVersion: "frontmatter-patch-v1",
    preview: "+type: person",
  });
  expect(() => reviewEffectProposal({
    ...proposal, effectPlan: { ...plan, additions: { type: "project" } },
  })).toThrow("identity is stale or invalid");
  expect(() => reviewEffectProposal({
    ...proposal, executorVersion: "frontmatter-patch-v0",
  })).toThrow("executor version changed");
});

function proposalFor(plan: { type: "frontmatter_patch"; additions: Record<string, string> }): ProposalRecord {
  const identity = {
    executorVersion: "frontmatter-patch-v1", sourceType: "vault_note",
    sourceId: "30 People/Ada.md", sourceHash: "sha256:source",
    targetPath: "30 People/Ada.md", targetHash: "sha256:target",
  };
  return {
    proposalId: "prop_effect", runId: "run_effect", actionId: "act_effect",
    workflow: "normalize_metadata", mode: "proposal", lifecycleState: "pending",
    permissionClass: "yellow", effectType: plan.type, effectPlan: plan,
    effectPlanHash: effectPlanHash({ plan, ...identity }), ...identity,
    createdAt: "2026-07-12T12:00:00.000Z", approved: false,
  };
}
