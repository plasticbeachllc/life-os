import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

import { ddl, schemaVersion } from "./schema";

export interface RunRecord {
  runId: string;
  workflow: string;
  mode: string;
  startedAt: string;
  completedAt?: string;
  status: string;
  agentVersion?: string;
  promptVersion?: string;
  modelVersion?: string;
}

export interface ActionRecord {
  actionId: string;
  runId: string;
  toolName: string;
  lifecycleState: string;
  permissionClass: string;
  arguments: Record<string, unknown>;
  targetEntityId?: string;
  targetPath?: string;
  sourceHash?: string;
  targetHash?: string;
}

export interface DerivedStateRecord {
  stateId: string;
  stateType: string;
  entityId?: string;
  stateVersion: number;
  content: Record<string, unknown>;
  sourceHashes: string[];
  generationMethod: string;
  promptVersion?: string;
  model?: string;
  createdAt: string;
}

export interface ModelCallRecord {
  callId: string;
  runId?: string;
  workflow: string;
  taskType: string;
  model: string;
  promptVersion: string;
  sourceHash?: string;
  contextHash: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cached: boolean;
  estimatedCost?: number;
  startedAt: string;
  completedAt?: string;
  status: string;
  error?: string;
}

export interface ProposalRecord {
  proposalId: string;
  runId: string;
  actionId: string;
  workflow: string;
  mode: string;
  lifecycleState: string;
  sourceType: string;
  sourceId: string;
  sourceHash: string;
  targetPath: string;
  targetHash: string;
  permissionClass: string;
  toolName: string;
  arguments: Record<string, unknown>;
  createdAt: string;
  expiresAt?: string;
  approved: boolean;
}

export interface UndoRecord {
  actionId: string;
  targetPath: string;
  backupPath: string;
  beforeHash: string;
  afterHash: string;
  createdAt: string;
  undoneAt?: string;
}

export interface ModelCacheRecord {
  cacheKey: string;
  output: unknown;
  inputTokens?: number;
  outputTokens?: number;
  expiresAt?: string;
}

export interface AuthorizationTokenRecord {
  tokenHash: string;
  purpose: "apply_proposal" | "undo_action";
  proposalId?: string;
  actionId: string;
  expectedTargetHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

export class OperationalStore {
  constructor(readonly databasePath: string) {}

  open(): Database {
    mkdirSync(dirname(this.databasePath), { recursive: true });
    const db = new Database(this.databasePath);
    db.exec("PRAGMA foreign_keys = ON");
    return db;
  }

  migrate(): void {
    const db = this.open();
    try {
      db.transaction(() => {
        for (const statement of ddl) db.exec(statement);
        const findingStatusColumns = new Set(db.query<{ name: string }, []>(
          "PRAGMA table_info(finding_status_events)",
        ).all().map((column) => column.name));
        if (!findingStatusColumns.has("related_entity_type")) {
          db.exec("ALTER TABLE finding_status_events ADD COLUMN related_entity_type TEXT CHECK(related_entity_type IN ('task'))");
        }
        if (!findingStatusColumns.has("related_entity_id")) {
          db.exec("ALTER TABLE finding_status_events ADD COLUMN related_entity_id TEXT");
        }
        db.query("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(schemaVersion, new Date().toISOString());
      })();
    } finally {
      db.close();
    }
  }

  getSchemaVersion(): number | undefined {
    if (!existsSync(this.databasePath)) return undefined;
    const db = this.open();
    try {
      const row = db
        .query<{ version: number | null }, []>("SELECT MAX(version) AS version FROM schema_migrations")
        .get();
      return row?.version ?? undefined;
    } catch {
      return undefined;
    } finally {
      db.close();
    }
  }

  recordRun(record: RunRecord): void {
    const db = this.open();
    try {
      db.query(
        `
        INSERT OR REPLACE INTO runs (
          run_id, workflow, mode, started_at, completed_at, status,
          agent_version, prompt_version, model_version, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        record.runId,
        record.workflow,
        record.mode,
        record.startedAt,
        record.completedAt ?? null,
        record.status,
        record.agentVersion ?? null,
        record.promptVersion ?? null,
        record.modelVersion ?? null,
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
  }

  recordAction(record: ActionRecord): void {
    const db = this.open();
    try {
      db.query(
        `
        INSERT OR REPLACE INTO actions (
          action_id, run_id, tool_name, lifecycle_state, permission_class,
          target_entity_id, target_path, source_hash, target_hash,
          arguments_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        record.actionId,
        record.runId,
        record.toolName,
        record.lifecycleState,
        record.permissionClass,
        record.targetEntityId ?? null,
        record.targetPath ?? null,
        record.sourceHash ?? null,
        record.targetHash ?? null,
        JSON.stringify(record.arguments),
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
  }

  recordActionResult(input: {
    actionId: string;
    runId: string;
    ok: boolean;
    message: string;
    filesModified: string[];
    error?: string;
  }): void {
    const db = this.open();
    try {
      db.query(
        `
        INSERT INTO action_results (
          action_id, run_id, ok, message, files_modified_json, error, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        input.actionId,
        input.runId,
        input.ok ? 1 : 0,
        input.message,
        JSON.stringify(input.filesModified),
        input.error ?? null,
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
  }

  createProposal(input: {
    proposalId: string; runId: string; actionId: string; workflow: string;
    sourceType: string; sourceId: string; sourceHash: string; targetPath: string;
    targetHash: string; toolName: string; permissionClass: string;
    arguments: Record<string, unknown>; createdAt: string; expiresAt?: string;
  }): ProposalRecord {
    const existing = this.findProposal(input.workflow, input.targetPath, input.targetHash);
    if (existing) return existing;
    const db = this.open();
    try {
      db.transaction(() => {
        db.query(
          `INSERT INTO runs (run_id, workflow, mode, started_at, completed_at, status, created_at)
           VALUES (?, ?, 'proposal', ?, ?, 'proposed', ?)`,
        ).run(input.runId, input.workflow, input.createdAt, input.createdAt, input.createdAt);
        db.query(
          `INSERT INTO proposals (
            proposal_id, run_id, workflow, mode, lifecycle_state, source_type, source_id,
            source_hash, target_path, target_hash, created_at, expires_at
          ) VALUES (?, ?, ?, 'proposal', 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.proposalId, input.runId, input.workflow, input.sourceType, input.sourceId,
          input.sourceHash, input.targetPath, input.targetHash, input.createdAt,
          input.expiresAt ?? null,
        );
        db.query(
          `INSERT INTO actions (
            action_id, run_id, tool_name, lifecycle_state, permission_class,
            target_path, source_hash, target_hash, arguments_json, created_at
          ) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.actionId, input.runId, input.toolName, input.permissionClass,
          input.targetPath, input.sourceHash, input.targetHash,
          JSON.stringify(input.arguments), input.createdAt,
        );
      })();
    } finally {
      db.close();
    }
    return this.getProposal(input.proposalId)!;
  }

  findProposal(workflow: string, targetPath: string, targetHash: string): ProposalRecord | undefined {
    return this.queryProposal(
      "WHERE p.workflow = ? AND p.target_path = ? AND p.target_hash = ?",
      [workflow, targetPath, targetHash],
    );
  }

  getProposal(proposalId: string): ProposalRecord | undefined {
    return this.queryProposal("WHERE p.proposal_id = ?", [proposalId]);
  }

  listPendingProposals(): ProposalRecord[] {
    const db = this.open();
    try {
      const rows = db.query<ProposalRow, []>(`${proposalSelect} WHERE p.lifecycle_state IN ('pending', 'approved') ORDER BY p.created_at`).all();
      return rows.map(toProposalRecord);
    } finally {
      db.close();
    }
  }

  approveProposalAction(proposalId: string, actionId: string, approvedAt: string): void {
    const db = this.open();
    try {
      db.transaction(() => {
        const proposal = db.query<{ lifecycle_state: string }, [string, string]>(
          `SELECT p.lifecycle_state FROM proposals p JOIN actions a ON a.run_id = p.run_id
           WHERE p.proposal_id = ? AND a.action_id = ?`,
        ).get(proposalId, actionId);
        if (!proposal) throw new Error("proposal action not found");
        if (proposal.lifecycle_state !== "pending" && proposal.lifecycle_state !== "approved") {
          throw new Error(`proposal cannot be approved from state: ${proposal.lifecycle_state}`);
        }
        db.query("INSERT OR IGNORE INTO approvals (proposal_id, action_id, approved_at) VALUES (?, ?, ?)")
          .run(proposalId, actionId, approvedAt);
        db.query("UPDATE actions SET lifecycle_state = 'approved' WHERE action_id = ?").run(actionId);
        db.query("UPDATE proposals SET lifecycle_state = 'approved' WHERE proposal_id = ?").run(proposalId);
      })();
    } finally {
      db.close();
    }
  }

  markProposalApplied(input: {
    proposalId: string; actionId: string; appliedAt: string; targetHash: string;
    backupPath: string; beforeHash: string; afterHash: string;
    findingConversion?: {
      eventId: string; findingId: string; expectedContentHash: string; taskId: string;
    };
  }): void {
    const db = this.open();
    try {
      db.transaction(() => {
        db.query("UPDATE actions SET lifecycle_state = 'applied', target_hash = ? WHERE action_id = ?")
          .run(input.targetHash, input.actionId);
        db.query("UPDATE proposals SET lifecycle_state = 'applied', applied_at = ? WHERE proposal_id = ?")
          .run(input.appliedAt, input.proposalId);
        db.query("INSERT INTO undo_records (action_id, target_path, backup_path, before_hash, after_hash, created_at) VALUES (?, (SELECT target_path FROM actions WHERE action_id = ?), ?, ?, ?, ?)")
          .run(input.actionId, input.actionId, input.backupPath, input.beforeHash, input.afterHash, input.appliedAt);
        if (input.findingConversion) {
          const finding = db.query<{ content_hash: string; status: string }, [string]>(`
            SELECT finding.content_hash,
              (SELECT event.status FROM finding_status_events event
               WHERE event.finding_id = finding.finding_id
               ORDER BY event.created_at DESC, event.event_id DESC LIMIT 1) AS status
            FROM findings finding WHERE finding.finding_id = ?
          `).get(input.findingConversion.findingId);
          if (!finding || finding.content_hash !== input.findingConversion.expectedContentHash
            || finding.status !== "active") {
            throw new Error("finding changed before task conversion was recorded");
          }
          db.query(`INSERT INTO finding_status_events (
            event_id, finding_id, status, related_entity_type, related_entity_id, created_at
          ) VALUES (?, ?, 'converted', 'task', ?, ?)`)
            .run(input.findingConversion.eventId, input.findingConversion.findingId,
              input.findingConversion.taskId, input.appliedAt);
        }
      })();
    } finally {
      db.close();
    }
  }

  getUndoRecord(actionId: string): UndoRecord | undefined {
    const db = this.open();
    try {
      const row = db.query<{
        action_id: string; target_path: string; backup_path: string; before_hash: string;
        after_hash: string; created_at: string; undone_at: string | null;
      }, [string]>("SELECT * FROM undo_records WHERE action_id = ? ORDER BY undo_id DESC LIMIT 1").get(actionId);
      if (!row) return undefined;
      return {
        actionId: row.action_id, targetPath: row.target_path, backupPath: row.backup_path,
        beforeHash: row.before_hash, afterHash: row.after_hash, createdAt: row.created_at,
        ...(row.undone_at ? { undoneAt: row.undone_at } : {}),
      };
    } finally {
      db.close();
    }
  }

  markActionUndone(actionId: string, undoneAt: string): void {
    const db = this.open();
    try {
      db.transaction(() => {
        const findingTask = db.query<{
          tool_name: string; source_id: string; arguments_json: string;
        }, [string]>(`
          SELECT action.tool_name, proposal.source_id, action.arguments_json
          FROM actions action JOIN proposals proposal ON proposal.run_id = action.run_id
          WHERE action.action_id = ?
        `).get(actionId);
        db.query("UPDATE undo_records SET undone_at = ? WHERE action_id = ? AND undone_at IS NULL").run(undoneAt, actionId);
        db.query("UPDATE actions SET lifecycle_state = 'undone' WHERE action_id = ?").run(actionId);
        if (findingTask?.tool_name === "append_finding_task") {
          const args = JSON.parse(findingTask.arguments_json) as Record<string, unknown>;
          const taskId = typeof args.taskId === "string" ? args.taskId : undefined;
          if (!taskId) throw new Error("finding task action lacks a stable task ID");
          db.query(`INSERT INTO finding_status_events (
            event_id, finding_id, status, related_entity_type, related_entity_id, reason, created_at
          ) VALUES (?, ?, 'active', 'task', ?, 'task creation undone', ?)`)
            .run(`findingevent_undo_${actionId}`, findingTask.source_id, taskId, undoneAt);
        }
      })();
    } finally {
      db.close();
    }
  }

  private queryProposal(where: string, parameters: string[]): ProposalRecord | undefined {
    const db = this.open();
    try {
      const row = db.query<ProposalRow, string[]>(`${proposalSelect} ${where} LIMIT 1`).get(...parameters);
      return row ? toProposalRecord(row) : undefined;
    } finally {
      db.close();
    }
  }

  saveDerivedState(record: DerivedStateRecord): void {
    const db = this.open();
    try {
      db.transaction(() => {
        db.query(
          `UPDATE derived_states SET superseded_at = ?
           WHERE state_type = ? AND entity_id IS ? AND superseded_at IS NULL`,
        ).run(record.createdAt, record.stateType, record.entityId ?? null);
        db.query(
          `INSERT INTO derived_states (
             state_id, state_type, entity_id, state_version, content_json,
             source_hashes_json, generation_method, prompt_version, model, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          record.stateId,
          record.stateType,
          record.entityId ?? null,
          record.stateVersion,
          JSON.stringify(record.content),
          JSON.stringify(record.sourceHashes),
          record.generationMethod,
          record.promptVersion ?? null,
          record.model ?? null,
          record.createdAt,
        );
      })();
    } finally {
      db.close();
    }
  }

  getCurrentDerivedState(stateType: string, entityId?: string): DerivedStateRecord | undefined {
    const db = this.open();
    try {
      const row = db.query<{
        state_id: string; state_type: string; entity_id: string | null; state_version: number;
        content_json: string; source_hashes_json: string; generation_method: string;
        prompt_version: string | null; model: string | null; created_at: string;
      }, [string, string | null]>(
        `SELECT * FROM derived_states
         WHERE state_type = ? AND entity_id IS ? AND superseded_at IS NULL
         ORDER BY state_version DESC LIMIT 1`,
      ).get(stateType, entityId ?? null);
      if (!row) return undefined;
      return {
        stateId: row.state_id,
        stateType: row.state_type,
        ...(row.entity_id ? { entityId: row.entity_id } : {}),
        stateVersion: row.state_version,
        content: JSON.parse(row.content_json) as Record<string, unknown>,
        sourceHashes: JSON.parse(row.source_hashes_json) as string[],
        generationMethod: row.generation_method,
        ...(row.prompt_version ? { promptVersion: row.prompt_version } : {}),
        ...(row.model ? { model: row.model } : {}),
        createdAt: row.created_at,
      };
    } finally {
      db.close();
    }
  }

  listCurrentDerivedStates(stateType: string): DerivedStateRecord[] {
    const db = this.open();
    try {
      const rows = db.query<{
        state_id: string; state_type: string; entity_id: string | null; state_version: number;
        content_json: string; source_hashes_json: string; generation_method: string;
        prompt_version: string | null; model: string | null; created_at: string;
      }, [string]>(
        "SELECT * FROM derived_states WHERE state_type = ? AND superseded_at IS NULL ORDER BY entity_id",
      ).all(stateType);
      return rows.map((row) => ({
        stateId: row.state_id, stateType: row.state_type,
        ...(row.entity_id ? { entityId: row.entity_id } : {}), stateVersion: row.state_version,
        content: JSON.parse(row.content_json) as Record<string, unknown>,
        sourceHashes: JSON.parse(row.source_hashes_json) as string[],
        generationMethod: row.generation_method,
        ...(row.prompt_version ? { promptVersion: row.prompt_version } : {}),
        ...(row.model ? { model: row.model } : {}), createdAt: row.created_at,
      }));
    } finally {
      db.close();
    }
  }

  getDerivedStateById(stateId: string): DerivedStateRecord | undefined {
    const db = this.open();
    try {
      const row = db.query<{
        state_id: string; state_type: string; entity_id: string | null; state_version: number;
        content_json: string; source_hashes_json: string; generation_method: string;
        prompt_version: string | null; model: string | null; created_at: string;
      }, [string]>("SELECT * FROM derived_states WHERE state_id = ?").get(stateId);
      if (!row) return undefined;
      return {
        stateId: row.state_id, stateType: row.state_type,
        ...(row.entity_id ? { entityId: row.entity_id } : {}), stateVersion: row.state_version,
        content: JSON.parse(row.content_json) as Record<string, unknown>,
        sourceHashes: JSON.parse(row.source_hashes_json) as string[],
        generationMethod: row.generation_method,
        ...(row.prompt_version ? { promptVersion: row.prompt_version } : {}),
        ...(row.model ? { model: row.model } : {}), createdAt: row.created_at,
      };
    } finally {
      db.close();
    }
  }

  recordModelCall(record: ModelCallRecord): void {
    const db = this.open();
    try {
      db.query(
        `INSERT INTO model_calls (
          call_id, run_id, workflow, task_type, model, prompt_version, source_hash,
          context_hash, input_tokens, output_tokens, cached_tokens, cached,
          estimated_cost, started_at, completed_at, status, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(call_id) DO UPDATE SET
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cached_tokens = excluded.cached_tokens,
          cached = excluded.cached,
          estimated_cost = excluded.estimated_cost,
          completed_at = excluded.completed_at,
          status = excluded.status,
          error = excluded.error`,
      ).run(
        record.callId, record.runId ?? null, record.workflow, record.taskType,
        record.model, record.promptVersion, record.sourceHash ?? null, record.contextHash,
        record.inputTokens ?? null, record.outputTokens ?? null, record.cachedTokens ?? null,
        record.cached ? 1 : 0, record.estimatedCost ?? null, record.startedAt,
        record.completedAt ?? null, record.status, record.error ?? null,
      );
    } finally {
      db.close();
    }
  }

  getModelCache(cacheKey: string, now = new Date()): ModelCacheRecord | undefined {
    const db = this.open();
    try {
      const row = db.query<{
        cache_key: string; output_json: string; input_tokens: number | null;
        output_tokens: number | null; expires_at: string | null;
      }, [string]>("SELECT cache_key, output_json, input_tokens, output_tokens, expires_at FROM model_cache WHERE cache_key = ?").get(cacheKey);
      if (!row || (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime())) return undefined;
      return {
        cacheKey: row.cache_key, output: JSON.parse(row.output_json) as unknown,
        ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
        ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
        ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      };
    } finally {
      db.close();
    }
  }

  putModelCache(input: {
    cacheKey: string; workflow: string; promptVersion: string; model: string;
    sourceHash: string; contextHash: string; schemaVersion: string; policyVersion: string;
    output: unknown; inputTokens?: number; outputTokens?: number; createdAt: string; expiresAt?: string;
  }): void {
    const db = this.open();
    try {
      db.query(
        `INSERT OR REPLACE INTO model_cache (
          cache_key, workflow, prompt_version, model, source_hash, context_hash,
          schema_version, policy_version, output_json, input_tokens, output_tokens, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.cacheKey, input.workflow, input.promptVersion, input.model, input.sourceHash,
        input.contextHash, input.schemaVersion, input.policyVersion, JSON.stringify(input.output),
        input.inputTokens ?? null, input.outputTokens ?? null, input.createdAt, input.expiresAt ?? null,
      );
    } finally {
      db.close();
    }
  }

  deleteModelCache(cacheKey: string): void {
    const db = this.open();
    try {
      db.query("DELETE FROM model_cache WHERE cache_key = ?").run(cacheKey);
    } finally {
      db.close();
    }
  }

  recordBriefingFeedback(input: { stateId: string; itemKey: string; useful: boolean; recordedAt: string }): void {
    const db = this.open();
    try {
      db.query(
        `INSERT INTO briefing_feedback (state_id, item_key, useful, recorded_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(state_id, item_key) DO UPDATE SET useful = excluded.useful, recorded_at = excluded.recorded_at`,
      ).run(input.stateId, input.itemKey, input.useful ? 1 : 0, input.recordedAt);
    } finally {
      db.close();
    }
  }

  saveAuthorizationToken(record: AuthorizationTokenRecord): void {
    const db = this.open();
    try {
      db.query(
        `INSERT INTO authorization_tokens (
          token_hash, purpose, proposal_id, action_id, expected_target_hash, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.tokenHash, record.purpose, record.proposalId ?? null, record.actionId,
        record.expectedTargetHash, record.createdAt, record.expiresAt,
      );
    } finally {
      db.close();
    }
  }

  consumeAuthorizationToken(input: {
    tokenHash: string; purpose: "apply_proposal" | "undo_action";
    proposalId?: string; actionId: string; expectedTargetHash: string; now: string;
  }): void {
    const db = this.open();
    try {
      db.transaction(() => {
        const row = db.query<{
          purpose: string; proposal_id: string | null; action_id: string;
          expected_target_hash: string; expires_at: string; used_at: string | null;
        }, [string]>("SELECT * FROM authorization_tokens WHERE token_hash = ?").get(input.tokenHash);
        if (!row) throw new Error("authorization token is invalid");
        if (row.used_at) throw new Error("authorization token has already been used");
        if (new Date(row.expires_at).getTime() <= new Date(input.now).getTime()) throw new Error("authorization token has expired");
        if (row.purpose !== input.purpose || row.action_id !== input.actionId
          || row.proposal_id !== (input.proposalId ?? null)
          || row.expected_target_hash !== input.expectedTargetHash) {
          throw new Error("authorization token does not match this operation");
        }
        db.query("UPDATE authorization_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
          .run(input.now, input.tokenHash);
      })();
    } finally {
      db.close();
    }
  }

  efficiencyMetrics(): {
    modelCalls: number; inputTokens: number; outputTokens: number; cachedTokens: number;
    estimatedCost: number; cacheHits: number; usefulBriefingItems: number;
    rejectedBriefingItems: number; feedbackItems: number;
  } {
    const db = this.open();
    try {
      const calls = db.query<{
        calls: number; input_tokens: number; output_tokens: number; cached_tokens: number;
        estimated_cost: number; cache_hits: number;
      }, []>(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(estimated_cost), 0) AS estimated_cost, COALESCE(SUM(cached), 0) AS cache_hits
        FROM model_calls WHERE status = 'completed'`).get()!;
      const feedback = db.query<{ useful: number; rejected: number; total: number }, []>(
        `SELECT COALESCE(SUM(useful), 0) AS useful, COALESCE(SUM(CASE WHEN useful = 0 THEN 1 ELSE 0 END), 0) AS rejected,
         COUNT(*) AS total FROM briefing_feedback`,
      ).get()!;
      return {
        modelCalls: calls.calls, inputTokens: calls.input_tokens, outputTokens: calls.output_tokens,
        cachedTokens: calls.cached_tokens, estimatedCost: calls.estimated_cost,
        cacheHits: calls.cache_hits, usefulBriefingItems: feedback.useful,
        rejectedBriefingItems: feedback.rejected, feedbackItems: feedback.total,
      };
    } finally {
      db.close();
    }
  }

  latestSourceHash(sourceType: string, sourceId: string): string | undefined {
    const db = this.open();
    try {
      return db.query<{ content_hash: string }, [string, string]>(
        `SELECT content_hash FROM change_events
         WHERE source_type = ? AND source_id = ? ORDER BY changed_at DESC LIMIT 1`,
      ).get(sourceType, sourceId)?.content_hash;
    } finally {
      db.close();
    }
  }

  recordChangeEvent(input: {
    changeId: string; sourceType: string; sourceId: string; contentHash: string;
    previousHash?: string; relevantSectionHashes: Record<string, string>; changedAt: string;
  }): void {
    const db = this.open();
    try {
      db.query(
        `INSERT OR IGNORE INTO change_events (
          change_id, source_type, source_id, content_hash, previous_hash,
          relevant_section_hashes_json, changed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.changeId, input.sourceType, input.sourceId, input.contentHash,
        input.previousHash ?? null, JSON.stringify(input.relevantSectionHashes), input.changedAt,
      );
    } finally {
      db.close();
    }
  }

  recordContextManifest(input: {
    manifestId: string; callId?: string; includedItems: unknown[]; omittedItems: unknown[];
    tokenBudget: unknown; retrievalLevels: number[]; rankingVersion: string;
    contextHash: string; createdAt: string;
  }): void {
    const db = this.open();
    try {
      db.query(
        `INSERT INTO context_manifests (
          manifest_id, call_id, included_items_json, omitted_items_json,
          token_budget_json, retrieval_levels_json, ranking_version, context_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.manifestId, input.callId ?? null, JSON.stringify(input.includedItems),
        JSON.stringify(input.omittedItems), JSON.stringify(input.tokenBudget),
        JSON.stringify(input.retrievalLevels), input.rankingVersion,
        input.contextHash, input.createdAt,
      );
    } finally {
      db.close();
    }
  }

  getModelCall(callId: string): ModelCallRecord | undefined {
    const db = this.open();
    try {
      const row = db.query<{
        call_id: string; run_id: string | null; workflow: string; task_type: string;
        model: string; prompt_version: string; source_hash: string | null; context_hash: string;
        input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null;
        cached: number; estimated_cost: number | null; started_at: string;
        completed_at: string | null; status: string; error: string | null;
      }, [string]>("SELECT * FROM model_calls WHERE call_id = ?").get(callId);
      if (!row) return undefined;
      return {
        callId: row.call_id, ...(row.run_id ? { runId: row.run_id } : {}),
        workflow: row.workflow, taskType: row.task_type, model: row.model,
        promptVersion: row.prompt_version, ...(row.source_hash ? { sourceHash: row.source_hash } : {}),
        contextHash: row.context_hash,
        ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
        ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
        ...(row.cached_tokens !== null ? { cachedTokens: row.cached_tokens } : {}),
        cached: Boolean(row.cached), ...(row.estimated_cost !== null ? { estimatedCost: row.estimated_cost } : {}),
        startedAt: row.started_at, ...(row.completed_at ? { completedAt: row.completed_at } : {}),
        status: row.status, ...(row.error ? { error: row.error } : {}),
      };
    } finally {
      db.close();
    }
  }

  getContextManifestForCall(callId: string): { includedItems: unknown[]; contextHash: string } | undefined {
    const db = this.open();
    try {
      const row = db.query<{ included_items_json: string; context_hash: string }, [string]>(
        "SELECT included_items_json, context_hash FROM context_manifests WHERE call_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get(callId);
      return row ? { includedItems: JSON.parse(row.included_items_json) as unknown[], contextHash: row.context_hash } : undefined;
    } finally {
      db.close();
    }
  }

  countRows(table: string): number {
    const allowed = new Set([
      "schema_migrations",
      "runs",
      "actions",
      "action_results",
      "file_versions",
      "workflow_state",
      "change_events",
      "derived_states",
      "subject_links",
      "findings",
      "finding_status_events",
      "model_calls",
      "context_manifests",
      "model_cache",
      "summary_versions",
      "retrieval_events",
      "proposals",
      "approvals",
      "rejections",
      "undo_records",
      "briefing_feedback",
      "authorization_tokens",
      "gmail_accounts",
      "gmail_ingestion_runs",
      "gmail_threads",
      "gmail_messages",
      "gmail_message_versions",
      "gmail_extractions",
      "imessage_sources",
      "imessage_ingestion_runs",
      "imessage_conversations",
      "imessage_messages",
      "imessage_message_versions",
      "imessage_extractions",
      "imessage_deterministic_triage",
      "calendar_accounts",
      "calendar_ingestion_runs",
      "calendar_events",
      "calendar_event_versions",
    ]);
    if (!allowed.has(table)) throw new Error(`unsupported table: ${table}`);
    const db = this.open();
    try {
      const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
      return row?.count ?? 0;
    } finally {
      db.close();
    }
  }
}

interface ProposalRow {
  proposal_id: string; run_id: string; action_id: string; workflow: string; mode: string;
  lifecycle_state: string; source_type: string; source_id: string; source_hash: string;
  target_path: string; target_hash: string; permission_class: string; tool_name: string;
  arguments_json: string; created_at: string; expires_at: string | null; approved: number;
}

const proposalSelect = `
  SELECT p.*, a.action_id, a.permission_class, a.tool_name, a.arguments_json,
    EXISTS(SELECT 1 FROM approvals ap WHERE ap.proposal_id = p.proposal_id AND ap.action_id = a.action_id) AS approved
  FROM proposals p JOIN actions a ON a.run_id = p.run_id
`;

function toProposalRecord(row: ProposalRow): ProposalRecord {
  return {
    proposalId: row.proposal_id, runId: row.run_id, actionId: row.action_id,
    workflow: row.workflow, mode: row.mode, lifecycleState: row.lifecycle_state,
    sourceType: row.source_type, sourceId: row.source_id, sourceHash: row.source_hash,
    targetPath: row.target_path, targetHash: row.target_hash,
    permissionClass: row.permission_class, toolName: row.tool_name,
    arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
    createdAt: row.created_at, ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    approved: Boolean(row.approved),
  };
}
