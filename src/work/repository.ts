import type { OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";
import { newId } from "../util/ids";
import type {
  EnqueueWorkInput, WorkErrorCategory, WorkItem, WorkState, WorkStatus, WorkWorkflow,
} from "./contract";

type DatabaseConnection = ReturnType<OperationalStore["open"]>;

interface WorkRow {
  work_id: string; workflow: WorkWorkflow; subject_type: WorkItem["subjectType"];
  subject_source_id: string; subject_id: string; anchor_id: string;
  source_hash: string; container_hash: string; reason: WorkItem["reason"];
  invalidation_key: string; state: WorkState; priority: number; attempts: number;
  max_attempts: number; lease_owner: string | null; lease_expires_at: string | null;
  available_at: string; error_category: WorkErrorCategory | null;
  created_at: string; updated_at: string; completed_at: string | null;
}

export function enqueueWorkInTransaction(
  db: DatabaseConnection, input: EnqueueWorkInput,
): { item: WorkItem; created: boolean } {
  const invalidationKey = workInvalidationKey(input);
  db.query(`
    UPDATE work_items SET state = 'stale', lease_owner = NULL, lease_expires_at = NULL,
      error_category = 'stale_source', updated_at = ?
    WHERE workflow = ? AND subject_source_id = ? AND subject_id = ?
      AND state IN ('pending', 'leased') AND invalidation_key <> ?
  `).run(input.now, input.workflow, input.subjectSourceId, input.subjectId, invalidationKey);
  const existing = queryByInvalidationKey(db, invalidationKey);
  if (existing) {
    if (existing.state === "stale") {
      db.query(`
        UPDATE work_items SET state = 'pending', attempts = 0, lease_owner = NULL,
          lease_expires_at = NULL, available_at = ?, error_category = NULL,
          updated_at = ?, completed_at = NULL WHERE work_id = ?
      `).run(input.now, input.now, existing.workId);
      return { item: queryById(db, existing.workId)!, created: false };
    }
    return { item: existing, created: false };
  }
  const workId = newId("work");
  db.query(`
    INSERT INTO work_items (
      work_id, workflow, subject_type, subject_source_id, subject_id, anchor_id,
      source_hash, container_hash, reason, invalidation_key, state, priority,
      attempts, max_attempts, available_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)
  `).run(
    workId, input.workflow, input.subjectType, input.subjectSourceId, input.subjectId,
    input.anchorId, input.sourceHash, input.containerHash, input.reason, invalidationKey,
    input.priority ?? 0, input.maxAttempts ?? 3, input.now, input.now, input.now,
  );
  return { item: queryById(db, workId)!, created: true };
}

export function completeWorkInTransaction(db: DatabaseConnection, input: {
  workId: string; leaseOwner: string; sourceHash: string; containerHash: string; completedAt: string;
}): void {
  const result = db.query(`
    UPDATE work_items SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
      error_category = NULL, completed_at = ?, updated_at = ?
    WHERE work_id = ? AND state = 'leased' AND lease_owner = ?
      AND source_hash = ? AND container_hash = ? AND lease_expires_at > ?
  `).run(
    input.completedAt, input.completedAt, input.workId, input.leaseOwner,
    input.sourceHash, input.containerHash, input.completedAt,
  );
  if (result.changes !== 1) throw new Error("work lease is stale or does not match the completed source");
}

/** Mark a queued or leased item stale without leaving a lease behind. */
export function markWorkStaleInTransaction(db: DatabaseConnection, input: {
  workId: string; updatedAt: string;
}): boolean {
  return db.query(`
    UPDATE work_items SET state = 'stale', lease_owner = NULL, lease_expires_at = NULL,
      error_category = 'stale_source', updated_at = ?
    WHERE work_id = ? AND state IN ('pending', 'leased')
  `).run(input.updatedAt, input.workId).changes === 1;
}

export class WorkRepository {
  constructor(private readonly store: OperationalStore) {}

  enqueue(input: EnqueueWorkInput): { item: WorkItem; created: boolean } {
    const db = this.store.open();
    try {
      return db.transaction(() => enqueueWorkInTransaction(db, input))();
    } finally {
      db.close();
    }
  }

  peekNext(input: { workflow: WorkWorkflow; subjectSourceId: string; now?: Date }): WorkItem | undefined {
    const db = this.store.open();
    try {
      return toWorkItem(db.query<WorkRow, [WorkWorkflow, string, string]>(`
        SELECT * FROM work_items WHERE workflow = ? AND subject_source_id = ?
          AND state = 'pending' AND available_at <= ?
        ORDER BY priority DESC, created_at, work_id LIMIT 1
      `).get(input.workflow, input.subjectSourceId, (input.now ?? new Date()).toISOString()));
    } finally {
      db.close();
    }
  }

  listReady(input: {
    workflow: WorkWorkflow; subjectSourceId: string; limit: number; now?: Date;
  }): WorkItem[] {
    const db = this.store.open();
    try {
      return db.query<WorkRow, [WorkWorkflow, string, string, number]>(`
        SELECT * FROM work_items WHERE workflow = ? AND subject_source_id = ?
          AND state = 'pending' AND available_at <= ?
        ORDER BY priority DESC, created_at, work_id LIMIT ?
      `).all(
        input.workflow, input.subjectSourceId, (input.now ?? new Date()).toISOString(), input.limit,
      ).map((row) => toWorkItem(row)!);
    } finally {
      db.close();
    }
  }

  claimNext(input: {
    workflow: WorkWorkflow; subjectSourceId: string; leaseOwner: string;
    leaseDurationMs: number; now?: Date;
  }): WorkItem | undefined {
    return this.claim({ ...input });
  }

  claimExact(input: {
    workId: string; leaseOwner: string; leaseDurationMs: number; now?: Date;
  }): WorkItem | undefined {
    return this.claim(input);
  }

  get(workId: string): WorkItem | undefined {
    const db = this.store.open();
    try {
      return queryById(db, workId);
    } finally {
      db.close();
    }
  }

  requireLease(input: {
    workId: string; leaseOwner: string; sourceHash: string; containerHash: string; now?: Date;
  }): WorkItem {
    const item = this.get(input.workId);
    const now = (input.now ?? new Date()).toISOString();
    if (!item || item.state !== "leased" || item.leaseOwner !== input.leaseOwner
      || item.sourceHash !== input.sourceHash || item.containerHash !== input.containerHash
      || !item.leaseExpiresAt || item.leaseExpiresAt <= now) {
      throw new Error("work lease is stale or does not match the prepared source");
    }
    return item;
  }

  complete(input: {
    workId: string; leaseOwner: string; sourceHash: string; containerHash: string; completedAt?: string;
  }): void {
    const db = this.store.open();
    try {
      db.transaction(() => completeWorkInTransaction(db, {
        ...input, completedAt: input.completedAt ?? new Date().toISOString(),
      }))();
    } finally {
      db.close();
    }
  }

  markStale(input: { workId: string; updatedAt?: string }): boolean {
    const db = this.store.open();
    try {
      const updatedAt = input.updatedAt ?? new Date().toISOString();
      return markWorkStaleInTransaction(db, { workId: input.workId, updatedAt });
    } finally {
      db.close();
    }
  }

  fail(input: {
    workId: string; leaseOwner: string; category: WorkErrorCategory;
    retryable: boolean; retryDelayMs?: number; now?: Date;
  }): WorkItem {
    const db = this.store.open();
    const now = input.now ?? new Date();
    try {
      db.exec("BEGIN IMMEDIATE");
      const current = queryById(db, input.workId);
      if (!current || current.state !== "leased" || current.leaseOwner !== input.leaseOwner) {
        throw new Error("work lease is stale");
      }
      const retry = input.retryable && current.attempts < current.maxAttempts;
      const state: WorkState = retry ? "pending" : "failed";
      const category = retry ? input.category
        : current.attempts >= current.maxAttempts ? "retry_exhausted" : input.category;
      const availableAt = new Date(now.getTime() + (input.retryDelayMs ?? 0)).toISOString();
      db.query(`
        UPDATE work_items SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
          available_at = ?, error_category = ?, updated_at = ? WHERE work_id = ?
      `).run(state, availableAt, category, now.toISOString(), input.workId);
      db.exec("COMMIT");
      return queryById(db, input.workId)!;
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }

  recoverExpired(now = new Date()): { recovered: number; failed: number } {
    const db = this.store.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = recoverExpiredInTransaction(db, now.toISOString());
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }

  status(now = new Date()): WorkStatus {
    const db = this.store.open();
    try {
      const stateRows = db.query<{ state: WorkState; count: number }, []>(
        "SELECT state, COUNT(*) AS count FROM work_items GROUP BY state",
      ).all();
      const workflowRows = db.query<{ workflow: WorkWorkflow; count: number }, []>(
        "SELECT workflow, COUNT(*) AS count FROM work_items GROUP BY workflow",
      ).all();
      const failureRows = db.query<{ error_category: WorkErrorCategory; count: number }, []>(`
        SELECT error_category, COUNT(*) AS count FROM work_items
        WHERE state = 'failed' AND error_category IS NOT NULL GROUP BY error_category
      `).all();
      const oldest = db.query<{ created_at: string | null }, []>(
        "SELECT MIN(created_at) AS created_at FROM work_items WHERE state = 'pending'",
      ).get()?.created_at;
      const byState: WorkStatus["byState"] = { pending: 0, leased: 0, completed: 0, stale: 0, failed: 0 };
      const byWorkflow: WorkStatus["byWorkflow"] = { gmail_extraction: 0, imessage_extraction: 0 };
      for (const row of stateRows) byState[row.state] = row.count;
      for (const row of workflowRows) byWorkflow[row.workflow] = row.count;
      const failureCategories: WorkStatus["failureCategories"] = {};
      for (const row of failureRows) failureCategories[row.error_category] = row.count;
      return {
        total: Object.values(byState).reduce((sum, count) => sum + count, 0),
        byState, byWorkflow, failureCategories,
        oldestPendingAgeSeconds: oldest
          ? Math.max(0, Math.floor((now.getTime() - new Date(oldest).getTime()) / 1000)) : null,
      };
    } finally {
      db.close();
    }
  }

  private claim(input: {
    workId?: string; workflow?: WorkWorkflow; subjectSourceId?: string;
    leaseOwner: string; leaseDurationMs: number; now?: Date;
  }): WorkItem | undefined {
    if (!input.leaseOwner || input.leaseDurationMs <= 0) throw new Error("a bounded work lease is required");
    const db = this.store.open();
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      recoverExpiredInTransaction(db, nowIso);
      const row = input.workId
        ? db.query<WorkRow, [string, string]>(`
            SELECT * FROM work_items WHERE work_id = ? AND state = 'pending' AND available_at <= ?
          `).get(input.workId, nowIso)
        : db.query<WorkRow, [WorkWorkflow, string, string]>(`
            SELECT * FROM work_items WHERE workflow = ? AND subject_source_id = ?
              AND state = 'pending' AND available_at <= ?
            ORDER BY priority DESC, created_at, work_id LIMIT 1
          `).get(input.workflow!, input.subjectSourceId!, nowIso);
      if (!row) {
        db.exec("COMMIT");
        return undefined;
      }
      const expiresAt = new Date(now.getTime() + input.leaseDurationMs).toISOString();
      const claimed = db.query(`
        UPDATE work_items SET state = 'leased', attempts = attempts + 1,
          lease_owner = ?, lease_expires_at = ?, error_category = NULL, updated_at = ?
        WHERE work_id = ? AND state = 'pending'
      `).run(input.leaseOwner, expiresAt, nowIso, row.work_id);
      if (claimed.changes !== 1) throw new Error("work claim lost a concurrency race");
      db.exec("COMMIT");
      return queryById(db, row.work_id);
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }
}

function recoverExpiredInTransaction(
  db: DatabaseConnection, now: string,
): { recovered: number; failed: number } {
  const failed = db.query(`
    UPDATE work_items SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
      error_category = 'retry_exhausted', updated_at = ?
    WHERE state = 'leased' AND lease_expires_at <= ? AND attempts >= max_attempts
  `).run(now, now).changes;
  const recovered = db.query(`
    UPDATE work_items SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
      available_at = ?, error_category = 'provider_transient', updated_at = ?
    WHERE state = 'leased' AND lease_expires_at <= ? AND attempts < max_attempts
  `).run(now, now, now).changes;
  return { recovered, failed };
}

function workInvalidationKey(input: EnqueueWorkInput): string {
  return sha256Value({
    workflow: input.workflow, subjectType: input.subjectType,
    subjectSourceId: input.subjectSourceId, subjectId: input.subjectId,
    anchorId: input.anchorId, sourceHash: input.sourceHash,
    containerHash: input.containerHash, reason: input.reason,
    contractIdentity: input.contractIdentity ?? null,
  });
}

function queryById(db: DatabaseConnection, workId: string): WorkItem | undefined {
  return toWorkItem(db.query<WorkRow, [string]>("SELECT * FROM work_items WHERE work_id = ?").get(workId));
}

function queryByInvalidationKey(db: DatabaseConnection, key: string): WorkItem | undefined {
  return toWorkItem(db.query<WorkRow, [string]>(
    "SELECT * FROM work_items WHERE invalidation_key = ?",
  ).get(key));
}

function toWorkItem(row: WorkRow | null | undefined): WorkItem | undefined {
  if (!row) return undefined;
  return {
    workId: row.work_id, workflow: row.workflow, subjectType: row.subject_type,
    subjectSourceId: row.subject_source_id, subjectId: row.subject_id,
    anchorId: row.anchor_id, sourceHash: row.source_hash, containerHash: row.container_hash,
    reason: row.reason, invalidationKey: row.invalidation_key, state: row.state,
    priority: row.priority, attempts: row.attempts, maxAttempts: row.max_attempts,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    availableAt: row.available_at,
    ...(row.error_category ? { errorCategory: row.error_category } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}
