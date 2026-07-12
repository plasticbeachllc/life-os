import type { ContextManifest } from "../context/builder";
import type { OperationalStore } from "../db/store";
import { newId } from "../util/ids";
import { modelCacheKey } from "./cache";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  estimatedCost?: number;
}

export interface ModelAdapter {
  complete(input: { model: string; instructions: string; context: unknown[]; outputSchema?: OutputSchema }): Promise<{
    output: unknown;
    usage: ModelUsage;
  }>;
}

export interface OutputSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface ModelCallInput {
  runId?: string;
  workflow: string;
  taskType: string;
  model: string;
  promptVersion: string;
  sourceHash?: string;
  instructions: string;
  manifest: ContextManifest;
  outputSchema?: OutputSchema;
  validateOutput?: (output: unknown) => void;
  cache?: {
    schemaVersion: string;
    policyVersion: string;
    expiresAt?: string;
  };
}

export class ModelGateway {
  constructor(private readonly store: OperationalStore, private readonly adapter: ModelAdapter) {}

  async complete(input: ModelCallInput): Promise<unknown> {
    const callId = newId("call");
    const startedAt = new Date().toISOString();
    const cacheKey = input.cache && input.sourceHash ? modelCacheKey({
      workflow: input.workflow, promptVersion: input.promptVersion, model: input.model,
      sourceHash: input.sourceHash, contextHash: input.manifest.contextHash,
      schemaVersion: input.cache.schemaVersion, policyVersion: input.cache.policyVersion,
    }) : undefined;
    this.store.recordModelCall({
      callId, ...(input.runId ? { runId: input.runId } : {}), workflow: input.workflow,
      taskType: input.taskType, model: input.model, promptVersion: input.promptVersion,
      ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
      contextHash: input.manifest.contextHash, cached: false, startedAt, status: "started",
    });
    this.store.recordContextManifest({
      manifestId: input.manifest.manifestId, callId,
      includedItems: input.manifest.includedItems, omittedItems: input.manifest.omittedItems,
      tokenBudget: input.manifest.tokenBudget, retrievalLevels: input.manifest.retrievalLevels,
      rankingVersion: input.manifest.rankingVersion, contextHash: input.manifest.contextHash,
      createdAt: input.manifest.createdAt,
    });

    const cached = cacheKey ? this.store.getModelCache(cacheKey) : undefined;
    if (cached) {
      try {
        input.validateOutput?.(cached.output);
      } catch (error) {
        this.store.recordModelCall({
          callId, ...(input.runId ? { runId: input.runId } : {}), workflow: input.workflow,
          taskType: input.taskType, model: input.model, promptVersion: input.promptVersion,
          ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
          contextHash: input.manifest.contextHash, cached: true, startedAt,
          completedAt: new Date().toISOString(), status: "failed",
          error: `invalid cached output: ${error instanceof Error ? error.message : String(error)}`,
        });
        this.store.deleteModelCache(cacheKey!);
        return this.complete({
          ...input,
          manifest: { ...input.manifest, manifestId: newId("manifest") },
        });
      }
      this.store.recordModelCall({
        callId, ...(input.runId ? { runId: input.runId } : {}), workflow: input.workflow,
        taskType: input.taskType, model: input.model, promptVersion: input.promptVersion,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        contextHash: input.manifest.contextHash, inputTokens: 0, outputTokens: 0,
        cachedTokens: cached.inputTokens ?? 0, cached: true, startedAt,
        completedAt: new Date().toISOString(), status: "completed",
      });
      return cached.output;
    }

    try {
      const result = await this.adapter.complete({
        model: input.model,
        instructions: input.instructions,
        context: input.manifest.includedItems.map((item) => item.content),
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      });
      input.validateOutput?.(result.output);
      this.store.recordModelCall({
        callId, ...(input.runId ? { runId: input.runId } : {}), workflow: input.workflow,
        taskType: input.taskType, model: input.model, promptVersion: input.promptVersion,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        contextHash: input.manifest.contextHash, inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ...(result.usage.cachedTokens !== undefined ? { cachedTokens: result.usage.cachedTokens } : {}),
        ...(result.usage.estimatedCost !== undefined ? { estimatedCost: result.usage.estimatedCost } : {}),
        cached: false, startedAt, completedAt: new Date().toISOString(), status: "completed",
      });
      if (cacheKey && input.cache && input.sourceHash) {
        this.store.putModelCache({
          cacheKey, workflow: input.workflow, promptVersion: input.promptVersion,
          model: input.model, sourceHash: input.sourceHash,
          contextHash: input.manifest.contextHash, schemaVersion: input.cache.schemaVersion,
          policyVersion: input.cache.policyVersion, output: result.output,
          inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
          createdAt: new Date().toISOString(),
          ...(input.cache.expiresAt ? { expiresAt: input.cache.expiresAt } : {}),
        });
      }
      return result.output;
    } catch (error) {
      this.store.recordModelCall({
        callId, ...(input.runId ? { runId: input.runId } : {}), workflow: input.workflow,
        taskType: input.taskType, model: input.model, promptVersion: input.promptVersion,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        contextHash: input.manifest.contextHash, cached: false, startedAt,
        completedAt: new Date().toISOString(), status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
