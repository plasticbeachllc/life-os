export type ModelTier = "none" | "extraction" | "reasoning";

export interface RoutingSignals {
  deterministicResolutionAvailable: boolean;
  ambiguity: number;
  consequenceOfError: number;
  contextComplexity: number;
  requiresSynthesis: boolean;
  structuredExtraction: boolean;
}

export interface ModelRoute {
  tier: ModelTier;
  model?: string;
  reason: string;
  maxEscalations: number;
}

export interface RouterConfig {
  extractionModel: string;
  reasoningModel: string;
}

export function routeModel(signals: RoutingSignals, config: RouterConfig): ModelRoute {
  if (signals.deterministicResolutionAvailable) {
    return { tier: "none", reason: "deterministic resolution available", maxEscalations: 0 };
  }
  const highStakes = signals.consequenceOfError >= 0.7;
  const complex = signals.contextComplexity >= 0.7 || signals.ambiguity >= 0.7;
  if (signals.requiresSynthesis || highStakes || complex || !signals.structuredExtraction) {
    return { tier: "reasoning", model: config.reasoningModel, reason: "judgment or ambiguity requires reasoning", maxEscalations: 0 };
  }
  return { tier: "extraction", model: config.extractionModel, reason: "bounded structured extraction", maxEscalations: 1 };
}
