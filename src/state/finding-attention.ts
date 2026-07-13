import type { DerivedStateRecord, OperationalStore } from "../db/store";
import { FindingStore, type ActiveFindingProjectionInput } from "../findings/store";
import { resolveAttention } from "../attention/resolver";
import type { AttentionSignal } from "../attention/contract";
import {
  ATTENTION_PRESENTATION_POLICY_VERSION,
  routeAttentionPresentation,
  type PresentationDecision,
} from "../attention/presentation";
import { sha256Value } from "../util/hashing";
import { materializeProjection, type ProjectionBuilder } from "./projection-contract";

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
  signal_count: number;
  signals: AttentionSignal[];
  presentation: PresentationDecision[];
  suppressed: {
    tracked_commitments: number;
    low_confidence_findings: number;
    missing_communication_context: number;
    unsupported_findings: number;
  };
}

const openLoopKinds = new Set(["explicit_request", "user_commitment", "other_commitment", "open_loop"]);
const commitmentKinds = new Set(["user_commitment", "other_commitment"]);
interface FindingAttentionInput {
  now: Date;
  active: ActiveFindingProjectionInput[];
  tasks: DerivedStateRecord[];
}

export const findingAttentionBuilder: ProjectionBuilder<FindingAttentionInput, FindingAttentionState> = {
  name: "finding-attention", version: "v4", stateType: "finding_attention_state",
  entityId: () => undefined,
  inputs: ({ now, active, tasks }) => [
    { type: "calendar_date", id: "current", hash: now.toISOString().slice(0, 10) },
    { type: "presentation_policy", id: "current", hash: ATTENTION_PRESENTATION_POLICY_VERSION },
    ...active.map((finding) => ({
      type: "active_finding", id: finding.findingId,
      hash: sha256Value([
        finding.contentHash, finding.statusEventId, finding.statusChangedAt,
      ]),
    })),
    ...tasks.map((task) => ({
      type: "task_state", id: task.entityId ?? task.stateId,
      hash: task.dependencyHash ?? sha256Value([task.stateId, task.stateVersion]),
    })),
  ],
  build: ({ now, active, tasks }) => {
    const date = now.toISOString().slice(0, 10);
    const openLoops = active.filter((finding) => openLoopKinds.has(finding.kind)).map(projectItem);
    const commitments = active.filter((finding) => commitmentKinds.has(finding.kind)).map(projectItem);
    const overdueFindingIds = openLoops
      .filter((finding) => finding.due_date !== null && finding.due_date < date)
      .map((finding) => finding.finding_id);
    const resolution = resolveAttention({ activeFindings: active, tasks, now });
    const presentation = routeAttentionPresentation({ signals: resolution.signals, now });
    return {
      as_of: now.toISOString(), open_loop_count: openLoops.length,
      commitment_count: commitments.length, overdue_count: overdueFindingIds.length,
      open_loops: openLoops, commitments, overdue_finding_ids: overdueFindingIds,
      signal_count: resolution.signals.length,
      signals: resolution.signals,
      presentation,
      suppressed: resolution.suppressed,
    };
  },
};

export function rebuildFindingAttentionState(input: {
  store: OperationalStore; now?: Date;
}): DerivedStateRecord {
  const now = input.now ?? new Date();
  const active = new FindingStore(input.store).activeProjectionInputs();
  const tasks = input.store.listCurrentDerivedStates("task_state");
  return materializeProjection({
    store: input.store, builder: findingAttentionBuilder, value: { now, active, tasks }, now,
  }).state;
}

function projectItem(finding: ActiveFindingProjectionInput): FindingAttentionItem {
  return {
    finding_id: finding.findingId, kind: finding.kind, statement: finding.statement,
    owner: finding.owner, due_date: finding.dueDate, confidence: finding.confidence,
    ambiguities: finding.ambiguities,
  };
}
