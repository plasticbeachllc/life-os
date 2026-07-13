import type { ObsidianVault, VaultNote } from "../adapters/obsidian";
import type { OperationalStore, ProposalRecord } from "../db/store";
import { sha256Text } from "../util/hashing";
import { newId } from "../util/ids";
import { createEffectProposal, findCurrentEffectProposal } from "../effects/proposals";

export interface NormalizationProposalReport {
  scanned: number;
  created: ProposalRecord[];
  existing: ProposalRecord[];
  issues: Array<{ path: string; message: string }>;
}

export async function proposeMetadataNormalization(input: {
  vault: ObsidianVault;
  store: OperationalStore;
}): Promise<NormalizationProposalReport> {
  input.vault.requireExists();
  input.store.migrate();
  const notes = (await input.vault.notes()).filter(isCandidate);
  const report: NormalizationProposalReport = { scanned: notes.length, created: [], existing: [], issues: [] };

  for (const note of notes) {
    if (note.frontmatterErrors.length > 0) {
      report.issues.push({ path: note.relativePath, message: `invalid frontmatter: ${note.frontmatterErrors.join("; ")}` });
      continue;
    }
    const additions = missingCanonicalMetadata(note);
    if (Object.keys(additions).length === 0) continue;
    const targetHash = sha256Text(note.raw);
    const prior = findCurrentEffectProposal({
      store: input.store, workflow: "normalize_metadata", targetPath: note.relativePath,
      targetHash, effectType: "frontmatter_patch",
    });
    if (prior) {
      report.existing.push(prior);
      continue;
    }
    const createdAt = new Date().toISOString();
    const proposal = createEffectProposal({ store: input.store,
      proposalId: newId("prop"), runId: newId("run"), actionId: newId("act"),
      workflow: "normalize_metadata", sourceType: "obsidian", sourceId: note.relativePath,
      sourceHash: targetHash, targetPath: note.relativePath, targetHash,
      plan: { type: "frontmatter_patch", additions },
      createdAt,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    report.created.push(proposal);
  }
  return report;
}

function isCandidate(note: VaultNote): boolean {
  return note.relativePath.startsWith("20 Projects/") || note.relativePath.startsWith("30 People/");
}

function missingCanonicalMetadata(note: VaultNote): Record<string, string> {
  const expectedType = note.relativePath.startsWith("20 Projects/") ? "project" : "person";
  const additions: Record<string, string> = {};
  if (!note.metadata.type) additions.type = expectedType;
  if (!note.metadata.id) additions.id = newId(expectedType);
  return additions;
}
