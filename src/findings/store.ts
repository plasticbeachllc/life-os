import type { OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";
import type { FindingStatus, SemanticFinding } from "./contract";

export interface ActiveFindingProjectionInput {
  findingId: string; kind: string; statement: string; owner: string;
  dueDate: string | null; confidence: number; ambiguities: string[];
  contentHash: string; statusEventId: string; statusChangedAt: string;
}

export class FindingStore {
  constructor(private readonly store: OperationalStore) {}

  saveProjection(findings: SemanticFinding[]): { created: number; unchanged: number } {
    if (findings.length === 0) return { created: 0, unchanged: 0 };
    const db = this.store.open();
    try {
      return db.transaction(() => {
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
      })();
    } finally {
      db.close();
    }
  }

  recordStatus(input: {
    findingId: string; status: FindingStatus; relatedFindingId?: string;
    reason?: string; createdAt?: string;
  }): string {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const db = this.store.open();
    try {
      const finding = db.query<{ finding_id: string }, [string]>(
        "SELECT finding_id FROM findings WHERE finding_id = ?",
      ).get(input.findingId);
      if (!finding) throw new Error("finding not found");
      if (input.relatedFindingId && !db.query(
        "SELECT 1 FROM findings WHERE finding_id = ?",
      ).get(input.relatedFindingId)) throw new Error("related finding not found");
      const identity = {
        findingId: input.findingId, status: input.status,
        relatedFindingId: input.relatedFindingId ?? null,
        reason: input.reason ?? null, createdAt,
      };
      const eventId = `findingevent_${sha256Value(identity).slice("sha256:".length, "sha256:".length + 24)}`;
      db.query(`
        INSERT OR IGNORE INTO finding_status_events (
          event_id, finding_id, status, related_finding_id, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        eventId, input.findingId, input.status, input.relatedFindingId ?? null,
        input.reason ?? null, createdAt,
      );
      return eventId;
    } finally {
      db.close();
    }
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
