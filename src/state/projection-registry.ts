import { chiefOfStaffBuilder } from "./chief-of-staff";
import { findingAttentionBuilder } from "./finding-attention";
import { ProjectionRegistry } from "./projection-contract";
import { personStateBuilder, projectStateBuilder, taskStateBuilder } from "./projections";

export function lifeOsProjectionRegistry(): ProjectionRegistry {
  const registry = new ProjectionRegistry();
  for (const builder of [
    projectStateBuilder, personStateBuilder, taskStateBuilder,
    findingAttentionBuilder, chiefOfStaffBuilder,
  ]) registry.register(builder);
  return registry;
}
