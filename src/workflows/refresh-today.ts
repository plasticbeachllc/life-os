import type { ObsidianVault } from "../adapters/obsidian";
import type { OperationalStore } from "../db/store";
import { createIntegrationRegistry } from "../integrations/providers";
import type { IntegrationRegistry } from "../integrations/registry";
import { rebuildState, type StateRebuildReport } from "./rebuild-state";

export type TodayRefreshProviderStatus = "ingested" | "disabled" | "failed";

export interface TodayRefreshReport {
  refreshedAt: string;
  providers: Array<{
    provider: string;
    status: TodayRefreshProviderStatus;
    changed: number;
    unchanged: number;
  }>;
  state: Pick<StateRebuildReport, "projected" | "retired" | "issues">;
  modelCalls: 0;
}

/**
 * Refreshes the bounded, read-only inputs needed for the Today workspace.
 * Provider failures are isolated so canonical-state rebuilding can still run.
 */
export async function refreshToday(input: {
  vault: ObsidianVault;
  store: OperationalStore;
  vaultPath: string;
  registry?: IntegrationRegistry;
  now?: Date;
}): Promise<TodayRefreshReport> {
  const registry = input.registry ?? createIntegrationRegistry();
  const providers: TodayRefreshReport["providers"] = [];

  for (const integration of registry.list()) {
    try {
      const status = await integration.status({ vaultPath: input.vaultPath });
      if (!status.enabled) {
        providers.push({ provider: integration.id, status: "disabled", changed: 0, unchanged: 0 });
        continue;
      }
      const result = await integration.ingest({ vaultPath: input.vaultPath });
      providers.push({ provider: integration.id, status: "ingested",
        changed: result.counts.changed, unchanged: result.counts.unchanged });
    } catch {
      // Provider errors may contain credentials, paths, or provider identifiers. Keep the UI receipt generic.
      providers.push({ provider: integration.id, status: "failed", changed: 0, unchanged: 0 });
    }
  }

  const rebuilt = await rebuildState({ vault: input.vault, store: input.store,
    ...(input.now ? { now: input.now } : {}) });
  return {
    refreshedAt: (input.now ?? new Date()).toISOString(), providers,
    state: { projected: rebuilt.projected, retired: rebuilt.retired, issues: rebuilt.issues.map((issue) => ({
      path: issue.path, message: issue.message,
    })) },
    modelCalls: 0,
  };
}

export function formatTodayRefresh(report: TodayRefreshReport): string {
  const providers = report.providers.map((provider) =>
    `${provider.provider}: ${provider.status} (${provider.changed} changed, ${provider.unchanged} unchanged)`).join("\n");
  return `Today refresh complete\n${providers}\nState: ${report.state.projected} projected, ${report.state.retired} retired\nModel calls: 0`;
}
