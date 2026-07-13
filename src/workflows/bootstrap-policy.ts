import { existsSync } from "node:fs";

import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore, ProposalRecord } from "../db/store";
import { mandatoryPolicyFiles, parsePermissions } from "../policy/loader";
import { sha256Text } from "../util/hashing";
import { newId } from "../util/ids";
import { createEffectProposal, findCurrentEffectProposal } from "../effects/proposals";

const copiedPolicySources: Partial<Record<keyof typeof mandatoryPolicyFiles, string>> = {
  constitution: "90 System/AI/Agent Constitution.md",
  permissions: "90 System/AI/Agent Permissions.md",
  agent: "90 System/AI/Chief of Staff Agent.md",
};

const generatedSchemas = `# Canonical Schemas

## Person

Required frontmatter: \`type: person\` and a stable \`person_*\` ID.

## Project

Required frontmatter: \`type: project\`, a stable \`project_*\` ID, and a valid status.

## Goal

Required frontmatter: \`type: goal\`, a stable \`goal_*\` ID, and a valid status.

## Safety

Canonical IDs are immutable. Human-authored journal content is never rewritten.
`;

const generatedPermissions = `[actions.apply_frontmatter_patch]
enabled = true
mode = "proposal"

[actions.bootstrap_policy_file]
enabled = true
mode = "proposal"

[actions.create_task]
enabled = true
mode = "proposal"

[actions.append_person_interaction]
enabled = true
mode = "proposal"

[actions.update_last_contact]
enabled = false
mode = "disabled"

[actions.append_inbox_item]
enabled = false
mode = "disabled"

[actions.create_calendar_event]
enabled = false
mode = "disabled"
`;

export async function proposePolicyBootstrap(input: {
  vault: ObsidianVault;
  store: OperationalStore;
}): Promise<{ created: ProposalRecord[]; existing: ProposalRecord[]; skipped: string[] }> {
  input.vault.requireExists();
  input.store.migrate();
  const created: ProposalRecord[] = [];
  const existing: ProposalRecord[] = [];
  const skipped: string[] = [];

  for (const [name, targetPath] of Object.entries(mandatoryPolicyFiles) as [keyof typeof mandatoryPolicyFiles, string][]) {
    if (existsSync(input.vault.path(targetPath))) {
      skipped.push(targetPath);
      continue;
    }
    const sourcePath = copiedPolicySources[name];
    const content = sourcePath ? await Bun.file(input.vault.path(sourcePath)).text() : generatedContent(name);
    if (name === "permissionsToml") parsePermissions(content);
    const sourceHash = sha256Text(content);
    const prior = findCurrentEffectProposal({
      store: input.store, workflow: "bootstrap_policy", targetPath,
      targetHash: "missing", effectType: "policy_bootstrap",
    });
    if (prior) {
      existing.push(prior);
      continue;
    }
    const createdAt = new Date().toISOString();
    created.push(createEffectProposal({ store: input.store,
      proposalId: newId("prop"), runId: newId("run"), actionId: newId("act"),
      workflow: "bootstrap_policy", sourceType: sourcePath ? "obsidian" : "builtin",
      sourceId: sourcePath ?? `builtin:${name}`, sourceHash, targetPath, targetHash: "missing",
      plan: { type: "policy_bootstrap", content, ...(sourcePath ? { sourcePath } : {}) },
      createdAt, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }));
  }
  return { created, existing, skipped };
}

function generatedContent(name: keyof typeof mandatoryPolicyFiles): string {
  if (name === "schemas") return generatedSchemas;
  if (name === "permissionsToml") return generatedPermissions;
  throw new Error(`no bootstrap source for policy: ${name}`);
}
