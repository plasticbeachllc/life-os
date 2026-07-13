import type { DerivedStateRecord, OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";
import { newId } from "../util/ids";

export interface ProjectionInputIdentity {
  type: string;
  id: string;
  hash: string;
}

export interface ProjectionBuilder<TInput, TContent extends object> {
  name: string;
  version: string;
  stateType: string;
  entityId(input: TInput): string | undefined;
  inputs(input: TInput): ProjectionInputIdentity[];
  build(input: TInput): TContent;
}

export interface ProjectionTarget {
  stateType: string;
  entityId?: string;
}

export class ProjectionRegistry {
  private readonly builders = new Map<string, { name: string; version: string; stateType: string }>();

  register(builder: { name: string; version: string; stateType: string }): void {
    if (this.builders.has(builder.stateType)) throw new Error(`projection builder already registered: ${builder.stateType}`);
    this.builders.set(builder.stateType, {
      name: builder.name, version: builder.version, stateType: builder.stateType,
    });
  }

  list(): Array<{ name: string; version: string; stateType: string }> {
    return [...this.builders.values()].sort((a, b) => a.stateType.localeCompare(b.stateType));
  }
}

export function materializeProjection<TInput, TContent extends object>(input: {
  store: OperationalStore;
  builder: ProjectionBuilder<TInput, TContent>;
  value: TInput;
  now?: Date;
}): { state: DerivedStateRecord; changed: boolean } {
  const entityId = input.builder.entityId(input.value);
  const provenance = normalizedInputs(input.builder.inputs(input.value));
  const dependencyHash = sha256Value({
    builder: input.builder.name,
    version: input.builder.version,
    inputs: provenance,
  });
  const prior = input.store.getCurrentDerivedState(input.builder.stateType, entityId);
  if (prior?.dependencyHash === dependencyHash) return { state: prior, changed: false };
  const now = input.now ?? new Date();
  const stateVersion = (prior?.stateVersion ?? 0) + 1;
  const content = input.builder.build(input.value) as Record<string, unknown>;
  if ("state_version" in content) content.state_version = stateVersion;
  const state: DerivedStateRecord = {
    stateId: newId("state"), stateType: input.builder.stateType,
    ...(entityId ? { entityId } : {}),
    stateVersion,
    content,
    sourceHashes: [dependencyHash, ...new Set(provenance.map((item) => item.hash))],
    generationMethod: `${input.builder.name}@${input.builder.version}`,
    builderName: input.builder.name,
    builderVersion: input.builder.version,
    inputProvenance: provenance,
    dependencyHash,
    createdAt: now.toISOString(),
  };
  input.store.saveDerivedState(state);
  return { state, changed: true };
}

export function targetIncludes(targets: ProjectionTarget[] | undefined, stateType: string, entityId?: string): boolean {
  if (!targets || targets.length === 0) return true;
  return targets.some((target) => target.stateType === stateType &&
    (target.entityId === undefined || target.entityId === entityId));
}

function normalizedInputs(inputs: ProjectionInputIdentity[]): ProjectionInputIdentity[] {
  const identities = inputs.map((item) => ({ ...item }));
  identities.sort((a, b) => `${a.type}:${a.id}:${a.hash}`.localeCompare(`${b.type}:${b.id}:${b.hash}`));
  const keys = new Set<string>();
  for (const item of identities) {
    if (!item.type || !item.id || !item.hash) throw new Error("projection input identities must be complete");
    const key = `${item.type}:${item.id}`;
    if (keys.has(key)) throw new Error(`duplicate projection input identity: ${key}`);
    keys.add(key);
  }
  return identities;
}
