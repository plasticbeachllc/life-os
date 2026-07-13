import type { LoadedPolicy, PolicyDocName } from "../policy/loader";
import { sha256Value } from "../util/hashing";

export type PromptWorkflow = "gmail_extraction" | "imessage_extraction" | "morning_reasoning";

export interface CompiledPolicyPrompt {
  version: string;
  text: string;
}

export interface EvidenceDescriptor {
  id: string;
  type: "provider_message" | "state" | "entity" | "change";
  scope: "selected" | "delta" | "context";
}

export interface PromptSpec {
  workflow: PromptWorkflow;
  version: string;
  specHash: string;
  instructions: string;
  rules: readonly string[];
  schema: Record<string, unknown>;
}

const workflowTerms: Record<PromptWorkflow, RegExp> = {
  gmail_extraction: /email|gmail|message|extract|source|evidence|privacy|untrusted/i,
  imessage_extraction: /message|conversation|extract|source|evidence|privacy|untrusted/i,
  morning_reasoning: /agent|brief|reason|priorit|decision|evidence|context|untrusted/i,
};

const mandatoryPolicyTerms = /\b(?:approval|approved|credential|do not|forbid|must|never|only|permission|privacy|prohibit|require|secret|untrusted|write|writes)\b/i;
const maxCompiledPolicyLines = 40;
const maxCompiledPolicyCharacters = 3_200;

/** Compile trusted canonical policy into a small, deterministic workflow excerpt. */
export function compilePolicyPrompt(policy: LoadedPolicy, workflow: PromptWorkflow): CompiledPolicyPrompt {
  if (!policy.policyVersion) throw new Error("validated policy is required");
  const mandatory: string[] = [];
  const preferred: string[] = [];
  const fallback: string[] = [];
  for (const name of ["constitution", "permissions", "agent", "schemas"] as PolicyDocName[]) {
    for (const line of policyLines(policy.found[name] ?? "")) {
      const labeled = `${name}: ${line}`;
      if (mandatoryPolicyTerms.test(line)) mandatory.push(labeled);
      else (workflowTerms[workflow].test(line) ? preferred : fallback).push(labeled);
    }
  }
  const required = unique(mandatory);
  if (required.length > maxCompiledPolicyLines || required.join("\n").length > maxCompiledPolicyCharacters) {
    throw new Error("mandatory canonical policy clauses exceed the compiled policy prompt budget");
  }
  const selected = [...required];
  for (const line of unique([...preferred, ...fallback])) {
    if (selected.length >= maxCompiledPolicyLines) break;
    const candidate = [...selected, line].join("\n");
    if (candidate.length <= maxCompiledPolicyCharacters) selected.push(line);
  }
  const text = selected.join("\n");
  if (!text) throw new Error("canonical policy contains no compilable instructions");
  return { version: policy.policyVersion, text };
}

export function definePromptSpec(input: {
  workflow: PromptWorkflow;
  baseVersion: string;
  instructions: string;
  rules: readonly string[];
  schema: Record<string, unknown>;
}): PromptSpec {
  const contract = {
    workflow: input.workflow,
    instructions: input.instructions,
    rules: input.rules,
    schema: input.schema,
  };
  const specHash = sha256Value(contract);
  return {
    workflow: input.workflow, version: `${input.baseVersion}-${specHash.slice(7, 15)}`,
    specHash, instructions: input.instructions, rules: input.rules, schema: input.schema,
  };
}

export function promptContext(spec: PromptSpec, policy: CompiledPolicyPrompt): {
  prompt_contract: { workflow: PromptWorkflow; spec_hash: string; rules: readonly string[] };
  canonical_policy: { policy_version: string; compiled_hash: string };
} {
  return {
    prompt_contract: { workflow: spec.workflow, spec_hash: spec.specHash, rules: spec.rules },
    canonical_policy: { policy_version: policy.version, compiled_hash: sha256Value(policy.text) },
  };
}

export function renderInstructions(spec: PromptSpec, policy?: CompiledPolicyPrompt): string {
  return policy ? `${spec.instructions}\nCanonical policy:\n${policy.text}` : spec.instructions;
}

function policyLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("```") && line !== "---")
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""))
    .filter((line) => line.length >= 8);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
