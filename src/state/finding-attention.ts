import type { DerivedStateRecord, OperationalStore } from "../db/store";
import { FindingStore, type ActiveFindingProjectionInput } from "../findings/store";
import { sha256Value } from "../util/hashing";
import { newId } from "../util/ids";

export interface FindingAttentionItem {
  finding_id: string;
  kind: string;
  statement: string;
  owner: string;
  due_date: string | null;
  confidence: number;
  ambiguities: string[];
}

export interface FindingAttentionState {
  as_of: string;
  open_loop_count: number;
  commitment_count: number;
  overdue_count: number;
  open_loops: FindingAttentionItem[];
  commitments: FindingAttentionItem[];
  overdue_finding_ids: string[];
}

const openLoopKinds = new Set(["explicit_request", "user_commitment", "other_commitment", "open_loop"]);
const commitmentKinds = new Set(["user_commitment", "other_commitment"]);
const projectionVersion = "deterministic-finding-attention-v1";

export function rebuildFindingAttentionState(input: {
  store: OperationalStore; now?: Date;
}): DerivedStateRecord {
  const now = input.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const active = new FindingStore(input.store).activeProjectionInputs();
  const openLoops = active.filter((finding) => openLoopKinds.has(finding.kind)).map(projectItem);
  const commitments = active.filter((finding) => commitmentKinds.has(finding.kind)).map(projectItem);
  const overdueFindingIds = openLoops
    .filter((finding) => finding.due_date !== null && finding.due_date < date)
    .map((finding) => finding.finding_id);
  const content: FindingAttentionState = {
    as_of: now.toISOString(),
    open_loop_count: openLoops.length,
    commitment_count: commitments.length,
    overdue_count: overdueFindingIds.length,
    open_loops: openLoops,
    commitments,
    overdue_finding_ids: overdueFindingIds,
  };
  const dependencyHash = sha256Value({
    projectionVersion, date,
    findings: active.map((finding) => [
      finding.findingId, finding.contentHash, finding.statusEventId, finding.statusChangedAt,
    ]),
  });
  const prior = input.store.getCurrentDerivedState("finding_attention_state");
  if (prior?.sourceHashes.includes(dependencyHash)) return prior;
  const record: DerivedStateRecord = {
    stateId: newId("state"), stateType: "finding_attention_state",
    stateVersion: (prior?.stateVersion ?? 0) + 1,
    content: content as unknown as Record<string, unknown>,
    sourceHashes: [dependencyHash, ...active.map((finding) => finding.contentHash)],
    generationMethod: projectionVersion, createdAt: now.toISOString(),
  };
  input.store.saveDerivedState(record);
  return record;
}

function projectItem(finding: ActiveFindingProjectionInput): FindingAttentionItem {
  return {
    finding_id: finding.findingId, kind: finding.kind, statement: finding.statement,
    owner: finding.owner, due_date: finding.dueDate, confidence: finding.confidence,
    ambiguities: finding.ambiguities,
  };
}
