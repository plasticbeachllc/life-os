import type { ProposalRecord } from "../db/store";
import { sha256Value } from "../util/hashing";

export type EffectType =
  | "frontmatter_patch"
  | "task_id_patch"
  | "policy_bootstrap"
  | "finding_task_append";

export interface FrontmatterPatchPlan {
  type: "frontmatter_patch";
  additions: Record<string, string>;
}

export interface TaskIdPatchPlan {
  type: "task_id_patch";
  patches: Array<{ line: number; taskText: string; taskId: string }>;
}

export interface PolicyBootstrapPlan {
  type: "policy_bootstrap";
  content: string;
  sourcePath?: string;
}

export interface FindingTaskAppendPlan {
  type: "finding_task_append";
  findingId: string;
  taskId: string;
  taskLine: string;
}

export type EffectPlan =
  | FrontmatterPatchPlan
  | TaskIdPatchPlan
  | PolicyBootstrapPlan
  | FindingTaskAppendPlan;

export function parseEffectPlan(value: unknown, expectedType?: EffectType): EffectPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("effect plan must be an object");
  const plan = value as Record<string, unknown>;
  if (!isEffectType(plan.type) || expectedType && plan.type !== expectedType) {
    throw new Error("effect plan type is not registered");
  }
  if (plan.type === "frontmatter_patch") {
    exactKeys(plan, ["type", "additions"]);
    if (!isStringRecord(plan.additions)) throw new Error("frontmatter effect additions are invalid");
    return { type: plan.type, additions: plan.additions };
  }
  if (plan.type === "task_id_patch") {
    exactKeys(plan, ["type", "patches"]);
    if (!Array.isArray(plan.patches) || plan.patches.length === 0) throw new Error("task ID effect patches are invalid");
    return {
      type: plan.type,
      patches: plan.patches.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task ID effect patch is invalid");
        const patch = value as Record<string, unknown>;
        exactKeys(patch, ["line", "taskText", "taskId"]);
        if (!Number.isInteger(patch.line) || Number(patch.line) < 1
          || typeof patch.taskText !== "string" || !patch.taskText
          || typeof patch.taskId !== "string" || !/^task_[A-Za-z0-9]+$/.test(patch.taskId)) {
          throw new Error("task ID effect patch fields are invalid");
        }
        return { line: Number(patch.line), taskText: patch.taskText, taskId: patch.taskId };
      }),
    };
  }
  if (plan.type === "policy_bootstrap") {
    exactKeys(plan, ["type", "content", "sourcePath"]);
    if (typeof plan.content !== "string" || !plan.content.trim()
      || !(plan.sourcePath === undefined || typeof plan.sourcePath === "string")) {
      throw new Error("policy bootstrap effect is invalid");
    }
    return {
      type: plan.type, content: plan.content,
      ...(plan.sourcePath ? { sourcePath: plan.sourcePath } : {}),
    };
  }
  exactKeys(plan, ["type", "findingId", "taskId", "taskLine"]);
  if (typeof plan.findingId !== "string" || !/^finding_[a-f0-9]+$/.test(plan.findingId)
    || typeof plan.taskId !== "string" || !/^task_[a-f0-9]+$/.test(plan.taskId)
    || typeof plan.taskLine !== "string" || !/^- \[ \] \S/.test(plan.taskLine)) {
    throw new Error("finding task append effect is invalid");
  }
  return {
    type: plan.type, findingId: plan.findingId,
    taskId: plan.taskId, taskLine: plan.taskLine,
  };
}

export function effectPlanHash(input: {
  plan: EffectPlan; executorVersion: string;
  sourceType: string; sourceId: string; sourceHash: string;
  targetPath: string; targetHash: string;
}): string {
  return sha256Value({
    effectType: input.plan.type, executorVersion: input.executorVersion,
    source: { type: input.sourceType, id: input.sourceId, hash: input.sourceHash },
    target: { path: input.targetPath, hash: input.targetHash },
    plan: input.plan,
  });
}

export function requireEffectPlan<T extends EffectType>(
  proposal: ProposalRecord, expectedType: T,
): Extract<EffectPlan, { type: T }> {
  if (proposal.effectType !== expectedType) throw new Error(`proposal effect is not ${expectedType}`);
  const plan = parseEffectPlan(proposal.effectPlan, expectedType) as Extract<EffectPlan, { type: T }>;
  const hash = effectPlanHash({
    plan, executorVersion: proposal.executorVersion,
    sourceType: proposal.sourceType, sourceId: proposal.sourceId, sourceHash: proposal.sourceHash,
    targetPath: proposal.targetPath, targetHash: proposal.targetHash,
  });
  if (hash !== proposal.effectPlanHash) throw new Error("effect plan identity is stale or invalid");
  return plan;
}

function isEffectType(value: unknown): value is EffectType {
  return ["frontmatter_patch", "task_id_patch", "policy_bootstrap", "finding_task_append"].includes(String(value));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error("effect plan contains unknown fields");
}
