export interface ContextBudget {
  maxInputTokens: number;
  reservedOutputTokens: number;
  sourceTokens: number;
  entityStateTokens: number;
  recentChangeTokens: number;
  policyTokens: number;
  contingencyTokens: number;
}

export function validateBudget(budget: ContextBudget): void {
  const allocated = budget.sourceTokens + budget.entityStateTokens + budget.recentChangeTokens
    + budget.policyTokens + budget.contingencyTokens;
  if (allocated > budget.maxInputTokens) {
    throw new Error(`context budget over-allocated: ${allocated} > ${budget.maxInputTokens}`);
  }
  if (budget.reservedOutputTokens < 0 || Object.values(budget).some((value) => value < 0)) {
    throw new Error("context budget values must be non-negative");
  }
}
