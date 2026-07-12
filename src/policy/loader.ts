import { existsSync } from "node:fs";

import { ObsidianVault } from "../adapters/obsidian";
import { sha256Value } from "../util/hashing";

export const mandatoryPolicyFiles = {
  constitution: "90 System/AI/Constitution.md",
  permissions: "90 System/AI/Permissions.md",
  schemas: "90 System/AI/Schemas.md",
  agent: "90 System/AI/Agent.md",
  permissionsToml: "90 System/AI/permissions.toml",
} as const;

export type PolicyDocName = keyof typeof mandatoryPolicyFiles;

export interface LoadedPolicy {
  found: Partial<Record<PolicyDocName, string>>;
  missing: Partial<Record<PolicyDocName, string>>;
  errors: string[];
  permissions?: PermissionsConfig;
  policyVersion?: string;
}

export type PermissionMode = "disabled" | "proposal" | "automatic";
export interface PermissionsConfig {
  actions: Record<string, { enabled: boolean; mode: PermissionMode }>;
}

export async function loadPolicy(vault: ObsidianVault): Promise<LoadedPolicy> {
  const found: Partial<Record<PolicyDocName, string>> = {};
  const missing: Partial<Record<PolicyDocName, string>> = {};
  const errors: string[] = [];

  for (const [name, relativePath] of Object.entries(mandatoryPolicyFiles) as [PolicyDocName, string][]) {
    const path = vault.path(relativePath);
    if (existsSync(path)) {
      found[name] = await Bun.file(path).text();
    } else {
      missing[name] = relativePath;
    }
  }

  let permissions: PermissionsConfig | undefined;
  const permissionsText = found.permissionsToml;
  if (permissionsText) {
    try {
      permissions = parsePermissions(permissionsText);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const policyVersion = Object.keys(missing).length === 0 && errors.length === 0
    ? sha256Value(found)
    : undefined;
  return {
    found, missing, errors,
    ...(permissions ? { permissions } : {}),
    ...(policyVersion ? { policyVersion } : {}),
  };
}

export function parsePermissions(text: string): PermissionsConfig {
  const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  const actions = parsed.actions;
  if (!actions || typeof actions !== "object" || Array.isArray(actions)) {
    throw new Error("permissions.toml must define [actions.<name>] tables");
  }
  const result: PermissionsConfig = { actions: {} };
  for (const [name, raw] of Object.entries(actions as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`invalid permission action: ${name}`);
    const action = raw as Record<string, unknown>;
    if (typeof action.enabled !== "boolean") throw new Error(`permission ${name} requires boolean enabled`);
    if (!new Set(["disabled", "proposal", "automatic"]).has(String(action.mode))) {
      throw new Error(`permission ${name} has invalid mode`);
    }
    const mode = String(action.mode) as PermissionMode;
    if (!action.enabled && mode !== "disabled") throw new Error(`permission ${name} is contradictory: disabled action must use disabled mode`);
    if (action.enabled && mode === "disabled") throw new Error(`permission ${name} is contradictory: enabled action cannot use disabled mode`);
    result.actions[name] = { enabled: action.enabled, mode };
  }
  return result;
}

export function compileActionPolicy(policy: LoadedPolicy, actionName: string): {
  allowed: boolean; requiresApproval: boolean; policyVersion: string; summary: string;
} {
  if (!policy.policyVersion || !policy.permissions) throw new Error("validated policy is required");
  const action = policy.permissions.actions[actionName];
  if (!action || !action.enabled || action.mode === "disabled") {
    return { allowed: false, requiresApproval: false, policyVersion: policy.policyVersion, summary: `${actionName} is disabled` };
  }
  return {
    allowed: true, requiresApproval: action.mode === "proposal", policyVersion: policy.policyVersion,
    summary: action.mode === "proposal" ? `${actionName} requires explicit approval` : `${actionName} may run automatically`,
  };
}
