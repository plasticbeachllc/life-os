import { buildContext, type ContextCandidate } from "../context/builder";
import type { OperationalStore } from "../db/store";
import type { ModelGateway } from "../orchestration/model-gateway";
import { routeModel, type RouterConfig } from "../orchestration/model-router";
import { sha256Value } from "../util/hashing";
import { morningPromptSpec } from "../orchestration/prompt-contracts";
import { promptContext, renderInstructions, type CompiledPolicyPrompt } from "../orchestration/prompt-spec";
import { morningEvidenceDescriptors, validateRecommendations } from "./subscription-reasoning";

export async function reasonAboutMorningBriefing(input: {
  store: OperationalStore;
  gateway: ModelGateway;
  routerConfig: RouterConfig;
  policyVersion: string;
  policyPrompt?: CompiledPolicyPrompt;
  schemaVersion: string;
}): Promise<unknown> {
  const daily = input.store.listCurrentDerivedStates("daily_state").at(-1);
  const chief = input.store.getCurrentDerivedState("chief_of_staff_state");
  if (!daily || !chief) throw new Error("daily and chief-of-staff state are required");
  const candidates: ContextCandidate[] = [
    {
      id: chief.stateId, category: "entity_state", retrievalLevel: 1,
      content: chief.content, tokenEstimate: estimateTokens(chief.content),
      relevance: 1, impact: 1, recency: 1, sourceRefs: [chief.stateId, ...chief.sourceHashes],
    },
    {
      id: daily.stateId, category: "entity_state", retrievalLevel: 1,
      content: daily.content, tokenEstimate: estimateTokens(daily.content),
      relevance: 1, impact: 0.9, recency: 1, sourceRefs: [daily.stateId, ...daily.sourceHashes],
    },
    {
      id: `policy:${morningPromptSpec.version}`, category: "policy", retrievalLevel: 0,
      content: input.policyPrompt ? promptContext(morningPromptSpec, input.policyPrompt) : {
        prompt_contract: { workflow: morningPromptSpec.workflow, spec_hash: morningPromptSpec.specHash, rules: morningPromptSpec.rules },
      },
      tokenEstimate: Math.ceil(JSON.stringify(input.policyPrompt ? promptContext(morningPromptSpec, input.policyPrompt) : morningPromptSpec.rules).length / 4),
      relevance: 1, impact: 1,
      sourceRefs: [morningPromptSpec.specHash, input.policyVersion],
    },
  ];
  const manifest = buildContext(candidates, {
    maxInputTokens: 3000, reservedOutputTokens: 700,
    sourceTokens: 0, entityStateTokens: 2200, recentChangeTokens: 0,
    policyTokens: 400, contingencyTokens: 400,
  });
  const route = routeModel({
    deterministicResolutionAvailable: false, ambiguity: 0.4, consequenceOfError: 0.5,
    contextComplexity: 0.5, requiresSynthesis: true, structuredExtraction: false,
  }, input.routerConfig);
  if (route.tier !== "reasoning" || !route.model) throw new Error("morning reasoning did not resolve to a reasoning model");
  const sourceHash = sha256Value([daily.stateId, daily.stateVersion, chief.stateId, chief.stateVersion]);
  const allowedEvidence = new Set(morningEvidenceDescriptors(manifest.includedItems).map((item) => item.id));
  return input.gateway.complete({
    workflow: "morning_briefing", taskType: "chief_of_staff_synthesis",
    model: route.model, promptVersion: morningPromptSpec.version, sourceHash,
    instructions: renderInstructions(morningPromptSpec, input.policyPrompt),
    manifest,
    outputSchema: {
      name: "morning_briefing_reasoning",
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          recommendations: {
            type: "array", maxItems: 8,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                summary: { type: "string" },
                reason: { type: "string" },
                evidenceIds: { type: "array", items: { type: "string" } },
                confidence: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["summary", "reason", "evidenceIds", "confidence"],
            },
          },
        },
        required: ["recommendations"],
      },
    },
    validateOutput: (output) => {
      if (!output || typeof output !== "object" || !("recommendations" in output)) {
        throw new Error("morning reasoning output does not match the required schema");
      }
      const recommendations = (output as { recommendations: unknown }).recommendations;
      validateRecommendations(recommendations);
      for (const item of recommendations) {
        if (item.evidenceIds.some((id) => !allowedEvidence.has(id))) {
          throw new Error("morning recommendation contains unrecognized evidence IDs");
        }
      }
    },
    cache: {
      schemaVersion: input.schemaVersion, policyVersion: input.policyVersion,
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    },
  });
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
