import type { Database } from "bun:sqlite";

import { saveFindingsInTransaction } from "../findings/store";
import type { SemanticFinding } from "../findings/contract";
import {
  completeReasoningCallInTransaction, type PreparedReasoningUsage,
} from "../orchestration/prepared-reasoning";
import type { ModelCallRecord } from "../db/store";
import type { EnqueueWorkInput } from "../work/contract";
import { completeWorkInTransaction, enqueueWorkInTransaction } from "../work/repository";
import type { AppendSourceEventInput } from "../events/contract";
import { appendSourceEventInTransaction } from "../events/repository";

export interface SqliteStore {
  open(): Database;
}

export interface TransactionRepositories {
  events: {
    append(input: AppendSourceEventInput): ReturnType<typeof appendSourceEventInTransaction>;
  };
  findings: {
    save(findings: SemanticFinding[]): { created: number; unchanged: number };
  };
  work: {
    enqueue(input: EnqueueWorkInput): ReturnType<typeof enqueueWorkInTransaction>;
    complete(input: Parameters<typeof completeWorkInTransaction>[1]): void;
  };
  reasoning: {
    complete(input: { call: ModelCallRecord; usage?: PreparedReasoningUsage; completedAt: string }): void;
  };
}

/**
 * Composes domain repositories over one connection and one transaction. The
 * connection is deliberately not exposed, so application handlers cannot add
 * arbitrary SQL while coordinating a commit.
 */
export function withRepositoryTransaction<Result>(
  store: SqliteStore, operation: (repositories: TransactionRepositories) => Result,
): Result {
  const db = store.open();
  const repositories: TransactionRepositories = {
    events: { append: (input) => appendSourceEventInTransaction(db, input) },
    findings: { save: (findings) => saveFindingsInTransaction(db, findings) },
    work: {
      enqueue: (input) => enqueueWorkInTransaction(db, input),
      complete: (input) => completeWorkInTransaction(db, input),
    },
    reasoning: {
      complete: (input) => completeReasoningCallInTransaction(db, input),
    },
  };
  try {
    return db.transaction(() => operation(repositories))();
  } finally {
    db.close();
  }
}
