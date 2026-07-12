import type { OperationalStore } from "../db/store";
import type { FindingStatus, SemanticFinding } from "./contract";

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
