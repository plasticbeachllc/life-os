import type { OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";
import type { ValidatedCommunicationContext, ValidatedFindingRelation } from "../attention/contract";
import type {
  FindingCommunicationContext, FindingRelation, FindingStatus,
  PriorFindingRelationCandidate, SemanticFinding,
} from "./contract";

export interface ActiveFindingProjectionInput {
  findingId: string; kind: string; statement: string; owner: string;
  dueDate: string | null; confidence: number; ambiguities: string[];
  contentHash: string; statusEventId: string; statusChangedAt: string;
}

export interface StoredFinding extends SemanticFinding {
  status: FindingStatus;
}

export interface PreparedFindingConversion {
  eventId: string; findingId: string; expectedContentHash: string; taskId: string;
}

type DatabaseConnection = ReturnType<OperationalStore["open"]>;

export function saveFindingsInTransaction(
  db: DatabaseConnection, findings: SemanticFinding[],
): { created: number; unchanged: number } {
  let created = 0;
  let unchanged = 0;
  for (const finding of findings) {
    const existing = db.query<{ content_hash: string }, [string, string, number]>(`
      SELECT content_hash FROM findings
      WHERE source_type = ? AND source_extraction_id = ? AND source_item_index = ?
    `).get(finding.sourceType, finding.sourceExtractionId, finding.sourceItemIndex);
    if (existing) {
      if (existing.content_hash !== finding.contentHash) {
        throw new Error("immutable finding projection conflicts with existing content");
      }
      unchanged += 1;
      continue;
    }
    db.query(`
      INSERT INTO findings (
        finding_id, source_type, source_extraction_id, source_item_index,
        reasoning_call_id, kind, statement, owner, due_date, confidence,
        ambiguities_json, evidence_json, evidence_count, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      finding.findingId, finding.sourceType, finding.sourceExtractionId,
      finding.sourceItemIndex, finding.reasoningCallId, finding.kind,
      finding.statement, finding.owner, finding.dueDate, finding.confidence,
      JSON.stringify(finding.ambiguities), JSON.stringify(finding.evidenceIds),
      finding.evidenceIds.length, finding.contentHash, finding.createdAt,
    );
    db.query(`
      INSERT INTO finding_status_events (event_id, finding_id, status, created_at)
      VALUES (?, ?, 'active', ?)
    `).run(`${finding.findingId}_active`, finding.findingId, finding.createdAt);
    created += 1;
  }
  return { created, unchanged };
}

export function saveFindingSemanticsInTransaction(
  db: DatabaseConnection,
  input: { communicationContexts: FindingCommunicationContext[]; relations: FindingRelation[] },
): void {
  for (const context of input.communicationContexts) {
    const existing = db.query<{ content_hash: string }, [string]>(
      "SELECT content_hash FROM finding_communication_contexts WHERE finding_id = ?",
    ).get(context.findingId);
    if (existing && existing.content_hash !== context.contentHash) {
      throw new Error("immutable finding communication context conflicts with existing content");
    }
    if (existing) continue;
    db.query(`INSERT INTO finding_communication_contexts (
      finding_id, direction, response_expectation, response_state,
      validator_method, validator_version, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      context.findingId, context.direction, context.responseExpectation, context.responseState,
      context.validatorMethod, context.validatorVersion, context.contentHash, context.createdAt,
    );
  }
  for (const relation of input.relations) {
    const existing = db.query<{ content_hash: string }, [string]>(
      "SELECT content_hash FROM finding_relations WHERE relation_id = ?",
    ).get(relation.relationId);
    if (existing && existing.content_hash !== relation.contentHash) {
      throw new Error("immutable finding relation conflicts with existing content");
    }
    if (existing) continue;
    db.query(`INSERT INTO finding_relations (
      relation_id, kind, from_finding_id, to_finding_id, confidence,
      validator_method, validator_version, evidence_json, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      relation.relationId, relation.kind, relation.fromFindingId, relation.toFindingId,
      relation.confidence, relation.validatorMethod, relation.validatorVersion,
      JSON.stringify(relation.evidenceIds), relation.contentHash, relation.createdAt,
    );
  }
}

export class FindingStore {
  constructor(private readonly store: OperationalStore) {}

  saveProjection(findings: SemanticFinding[]): { created: number; unchanged: number } {
    if (findings.length === 0) return { created: 0, unchanged: 0 };
    const db = this.store.open();
    try {
      return db.transaction(() => saveFindingsInTransaction(db, findings))();
    } finally {
      db.close();
    }
  }

  activeRelationCandidatesForContainer(input:
    | { sourceType: "gmail_extraction"; sourceId: string; containerId: string }
    | { sourceType: "imessage_extraction"; sourceId: string; containerId: string }
  ): PriorFindingRelationCandidate[] {
    const db = this.store.open();
    try {
      const rows = input.sourceType === "gmail_extraction"
        ? db.query<RelationCandidateRow, [string, string]>(`
          SELECT finding.finding_id, finding.kind, finding.statement, finding.owner,
            finding.due_date, finding.content_hash
          FROM findings finding
          JOIN gmail_extractions extraction ON extraction.extraction_id = finding.source_extraction_id
          JOIN gmail_messages message ON message.account_id = extraction.account_id
            AND message.message_id = extraction.message_id
          WHERE finding.source_type = 'gmail_extraction'
            AND extraction.account_id = ? AND message.thread_id = ?
            AND (SELECT event.status FROM finding_status_events event
              WHERE event.finding_id = finding.finding_id
              ORDER BY event.created_at DESC, event.event_id DESC LIMIT 1) = 'active'
          ORDER BY finding.created_at DESC, finding.finding_id LIMIT 20
        `).all(input.sourceId, input.containerId)
        : db.query<RelationCandidateRow, [string, string]>(`
          SELECT finding.finding_id, finding.kind, finding.statement, finding.owner,
            finding.due_date, finding.content_hash
          FROM findings finding
          JOIN imessage_extractions extraction ON extraction.extraction_id = finding.source_extraction_id
          WHERE finding.source_type = 'imessage_extraction'
            AND extraction.source_id = ? AND extraction.conversation_id = ?
            AND (SELECT event.status FROM finding_status_events event
              WHERE event.finding_id = finding.finding_id
              ORDER BY event.created_at DESC, event.event_id DESC LIMIT 1) = 'active'
          ORDER BY finding.created_at DESC, finding.finding_id LIMIT 20
        `).all(input.sourceId, input.containerId);
      return rows.map(relationCandidate);
    } finally { db.close(); }
  }

  activeCommunicationContexts(): ValidatedCommunicationContext[] {
    const db = this.store.open();
    try {
      return db.query<{
        finding_id: string; direction: ValidatedCommunicationContext["direction"];
        response_expectation: ValidatedCommunicationContext["response_expectation"];
        response_state: ValidatedCommunicationContext["response_state"];
        validator_method: "deterministic"; validator_version: string; content_hash: string;
      }, []>(`SELECT context.* FROM finding_communication_contexts context
        WHERE (SELECT event.status FROM finding_status_events event
          WHERE event.finding_id = context.finding_id
          ORDER BY event.created_at DESC, event.event_id DESC LIMIT 1) = 'active'
        ORDER BY context.finding_id`).all().map((row) => ({
          finding_id: row.finding_id, direction: row.direction,
          response_expectation: row.response_expectation, response_state: row.response_state,
          validator: { method: row.validator_method, version: row.validator_version },
          content_hash: row.content_hash,
        }));
    } finally { db.close(); }
  }

  activeRelations(): ValidatedFindingRelation[] {
    const db = this.store.open();
    try {
      return db.query<{
        relation_id: string; kind: ValidatedFindingRelation["kind"];
        from_finding_id: string; to_finding_id: string; confidence: number;
        validator_method: "validated_reasoning"; validator_version: string; content_hash: string;
      }, []>(`SELECT relation.* FROM finding_relations relation
        WHERE (SELECT event.status FROM finding_status_events event
          WHERE event.finding_id = relation.from_finding_id
          ORDER BY event.created_at DESC, event.event_id DESC LIMIT 1) = 'active'
          AND (SELECT event.status FROM finding_status_events event
          WHERE event.finding_id = relation.to_finding_id
          ORDER BY event.created_at DESC, event.event_id DESC LIMIT 1) = 'active'
        ORDER BY relation.relation_id`).all().map((row) => ({
          relation_id: row.relation_id, kind: row.kind,
          from_finding_id: row.from_finding_id, to_finding_id: row.to_finding_id,
          confidence: row.confidence,
          validator: { method: row.validator_method, version: row.validator_version },
          content_hash: row.content_hash,
        }));
    } finally { db.close(); }
  }

  get(findingId: string): StoredFinding | undefined {
    const db = this.store.open();
    try {
      const row = db.query<{
        finding_id: string; source_type: SemanticFinding["sourceType"];
        source_extraction_id: string; source_item_index: number; reasoning_call_id: string;
        kind: SemanticFinding["kind"]; statement: string; owner: SemanticFinding["owner"];
        due_date: string | null; confidence: number; ambiguities_json: string;
        evidence_json: string; content_hash: string; created_at: string; status: FindingStatus;
      }, [string]>(`
        SELECT finding.*,
          (SELECT event.status FROM finding_status_events event
           WHERE event.finding_id = finding.finding_id
           ORDER BY event.created_at DESC, event.event_id DESC LIMIT 1) AS status
        FROM findings finding WHERE finding.finding_id = ?
      `).get(findingId);
      return row ? {
        findingId: row.finding_id, sourceType: row.source_type,
        sourceExtractionId: row.source_extraction_id, sourceItemIndex: row.source_item_index,
        reasoningCallId: row.reasoning_call_id, kind: row.kind, statement: row.statement,
        owner: row.owner, dueDate: row.due_date, confidence: row.confidence,
        ambiguities: JSON.parse(row.ambiguities_json) as string[],
        evidenceIds: JSON.parse(row.evidence_json) as string[], contentHash: row.content_hash,
        createdAt: row.created_at, status: row.status,
      } : undefined;
    } finally {
      db.close();
    }
  }
  findBySource(sourceType: SemanticFinding["sourceType"], extractionId: string,
    itemIndex: number): StoredFinding | undefined {
    const db = this.store.open();
    try {
      const findingId = db.query<{ finding_id: string }, [string, string, number]>(`
        SELECT finding_id FROM findings
        WHERE source_type = ? AND source_extraction_id = ? AND source_item_index = ?
      `).get(sourceType, extractionId, itemIndex)?.finding_id;
      return findingId ? this.get(findingId) : undefined;
    } finally {
      db.close();
    }
  }

  dismiss(input: { findingId: string; reason: string; createdAt?: string }): string {
    if (!input.reason.trim()) throw new Error("finding dismissal requires a reason");
    return this.appendTerminalStatus({
      findingId: input.findingId, status: "dismissed", reason: input.reason.trim(),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
  }

  supersede(input: {
    findingId: string; replacementFindingId: string; reason: string; createdAt?: string;
  }): string {
    if (input.findingId === input.replacementFindingId) throw new Error("finding cannot supersede itself");
    if (!input.reason.trim()) throw new Error("finding supersession requires a reason");
    const replacement = this.get(input.replacementFindingId);
    if (!replacement) throw new Error("replacement finding not found");
    if (replacement.status !== "active") throw new Error("replacement finding is not active");
    return this.appendTerminalStatus({
      findingId: input.findingId, status: "superseded",
      relatedFindingId: input.replacementFindingId, reason: input.reason.trim(),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
  }

  prepareTaskConversion(input: {
    findingId: string; taskId: string; createdAt?: string;
  }): PreparedFindingConversion {
    const finding = this.requireActive(input.findingId);
    if (!/^task_[a-f0-9]+$/.test(input.taskId)) throw new Error("invalid stable task ID for finding conversion");
    const createdAt = input.createdAt ?? new Date().toISOString();
    return {
      eventId: this.statusEventId({
        findingId: finding.findingId, status: "converted", relatedEntityType: "task",
        relatedEntityId: input.taskId, createdAt,
      }),
      findingId: finding.findingId, expectedContentHash: finding.contentHash, taskId: input.taskId,
    };
  }

  private appendTerminalStatus(input: {
    findingId: string; status: "dismissed" | "superseded";
    relatedFindingId?: string; reason: string; createdAt?: string;
  }): string {
    this.requireActive(input.findingId);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const db = this.store.open();
    try {
      const eventId = this.statusEventId({ ...input, createdAt });
      db.query(`
        INSERT OR IGNORE INTO finding_status_events (
          event_id, finding_id, status, related_finding_id, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        eventId, input.findingId, input.status, input.relatedFindingId ?? null,
        input.reason, createdAt,
      );
      return eventId;
    } finally {
      db.close();
    }
  }

  private requireActive(findingId: string): StoredFinding {
    const finding = this.get(findingId);
    if (!finding) throw new Error("finding not found");
    if (finding.status !== "active") throw new Error(`finding is not active: ${finding.status}`);
    return finding;
  }

  private statusEventId(identity: Record<string, unknown>): string {
    return `findingevent_${sha256Value(identity).slice("sha256:".length, "sha256:".length + 24)}`;
  }

  activeProjectionInputs(): ActiveFindingProjectionInput[] {
    const db = this.store.open();
    try {
      return db.query<{
        finding_id: string; kind: string; statement: string; owner: string;
        due_date: string | null; confidence: number; ambiguities_json: string;
        content_hash: string; event_id: string; status: FindingStatus; status_changed_at: string;
      }, []>(`
        SELECT finding.finding_id, finding.kind, finding.statement, finding.owner,
          finding.due_date, finding.confidence, finding.ambiguities_json,
          finding.content_hash, event.event_id, event.status,
          event.created_at AS status_changed_at
        FROM findings finding
        JOIN finding_status_events event ON event.event_id = (
          SELECT latest.event_id FROM finding_status_events latest
          WHERE latest.finding_id = finding.finding_id
          ORDER BY latest.created_at DESC, latest.event_id DESC LIMIT 1
        )
        WHERE event.status = 'active'
        ORDER BY finding.created_at, finding.source_type,
          finding.source_extraction_id, finding.source_item_index
      `).all().map((row) => ({
        findingId: row.finding_id, kind: row.kind, statement: row.statement,
        owner: row.owner, dueDate: row.due_date, confidence: row.confidence,
        ambiguities: JSON.parse(row.ambiguities_json) as string[],
        contentHash: row.content_hash, statusEventId: row.event_id,
        statusChangedAt: row.status_changed_at,
      }));
    } finally {
      db.close();
    }
  }

  review(): {
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    findings: Array<{
      findingId: string; kind: string; statement: string; owner: string;
      dueDate: string | null; confidence: number; ambiguities: string[];
      evidenceCount: number; status: FindingStatus; createdAt: string;
    }>;
  } {
    const db = this.store.open();
    try {
      const rows = db.query<{
        finding_id: string; kind: string; statement: string; owner: string;
        due_date: string | null; confidence: number; ambiguities_json: string;
        evidence_count: number; status: FindingStatus; created_at: string;
      }, []>(`
        SELECT finding.finding_id, finding.kind, finding.statement, finding.owner,
          finding.due_date, finding.confidence, finding.ambiguities_json,
          finding.evidence_count, finding.created_at,
          (SELECT event.status FROM finding_status_events event
           WHERE event.finding_id = finding.finding_id
           ORDER BY event.created_at DESC, event.event_id DESC LIMIT 1) AS status
        FROM findings finding
        ORDER BY finding.created_at DESC, finding.finding_id
      `).all();
      const byKind: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      const findings = rows.map((row) => {
        byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
        byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
        return {
          findingId: row.finding_id, kind: row.kind, statement: row.statement,
          owner: row.owner, dueDate: row.due_date, confidence: row.confidence,
          ambiguities: JSON.parse(row.ambiguities_json) as string[],
          evidenceCount: row.evidence_count, status: row.status, createdAt: row.created_at,
        };
      });
      return { total: findings.length, byKind, byStatus, findings };
    } finally {
      db.close();
    }
  }
}

interface RelationCandidateRow {
  finding_id: string; kind: PriorFindingRelationCandidate["kind"];
  statement: string; owner: PriorFindingRelationCandidate["owner"];
  due_date: string | null; content_hash: string;
}

function relationCandidate(row: RelationCandidateRow): PriorFindingRelationCandidate {
  return {
    findingId: row.finding_id, kind: row.kind, statement: row.statement,
    owner: row.owner, dueDate: row.due_date, contentHash: row.content_hash,
  };
}
