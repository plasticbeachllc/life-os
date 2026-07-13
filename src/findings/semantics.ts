import { sha256Value } from "../util/hashing";
import type {
  ExtractionFindingRelation, FindingCommunicationContext, FindingRelation,
  PriorFindingRelationCandidate, SemanticFinding,
} from "./contract";

export const FINDING_COMMUNICATION_VALIDATOR_VERSION = "finding-communication-v1";

export function deriveFindingSemantics(input: {
  findings: SemanticFinding[];
  evidenceDirections: Map<string, FindingCommunicationContext["direction"]>;
  relations: ExtractionFindingRelation[];
  priorFindings: PriorFindingRelationCandidate[];
  relationValidatorVersion: string;
}): { communicationContexts: FindingCommunicationContext[]; relations: FindingRelation[] } {
  const communicationContexts = input.findings.map((finding) => communicationContext(
    finding, input.evidenceDirections,
  ));
  const contexts = new Map(communicationContexts.map((context) => [context.findingId, context]));
  const prior = new Map(input.priorFindings.map((finding) => [finding.findingId, finding]));
  const identities = new Set<string>();
  const relations = input.relations.map((relation) => {
    if (!Number.isInteger(relation.fromItemIndex) || relation.fromItemIndex < 0
      || relation.fromItemIndex >= input.findings.length) {
      throw new Error("finding relation source item is invalid");
    }
    const from = input.findings[relation.fromItemIndex]!;
    const target = prior.get(relation.toFindingId);
    if (!target) throw new Error("finding relation target is not an active prepared candidate");
    if (!Number.isFinite(relation.confidence) || relation.confidence < 0.75 || relation.confidence > 1) {
      throw new Error("finding relation confidence is invalid");
    }
    if (!Array.isArray(relation.evidenceIds) || relation.evidenceIds.length === 0
      || relation.evidenceIds.some((id) => !from.evidenceIds.includes(id))) {
      throw new Error("finding relation evidence is not bound to its source finding");
    }
    requireCompatibleRelation(relation.kind, from, target, contexts.get(from.findingId)!);
    const identity = `${relation.kind}:${from.findingId}:${target.findingId}`;
    if (identities.has(identity)) throw new Error("finding relation is duplicated");
    identities.add(identity);
    const content = {
      kind: relation.kind, fromFindingId: from.findingId, toFindingId: target.findingId,
      fromContentHash: from.contentHash, toContentHash: target.contentHash,
      confidence: relation.confidence, evidenceIds: [...relation.evidenceIds].sort(),
      validatorMethod: "validated_reasoning" as const,
      validatorVersion: input.relationValidatorVersion,
    };
    const contentHash = sha256Value(content);
    return {
      relationId: `relation_${contentHash.slice("sha256:".length, "sha256:".length + 24)}`,
      kind: relation.kind, fromFindingId: from.findingId, toFindingId: target.findingId,
      confidence: relation.confidence, validatorMethod: content.validatorMethod,
      validatorVersion: input.relationValidatorVersion,
      evidenceIds: content.evidenceIds, contentHash, createdAt: from.createdAt,
    };
  });
  return { communicationContexts, relations };
}

function communicationContext(
  finding: SemanticFinding,
  evidenceDirections: Map<string, FindingCommunicationContext["direction"]>,
): FindingCommunicationContext {
  const directions = new Set(finding.evidenceIds
    .map((id) => evidenceDirections.get(id)).filter((value): value is FindingCommunicationContext["direction"] => Boolean(value)));
  const direction = directions.size === 1 ? [...directions][0]! : "unknown";
  const required = direction === "incoming" && finding.kind === "explicit_request" && finding.owner === "user";
  const responseExpectation = required ? "required" as const
    : direction === "outgoing" || finding.kind !== "explicit_request" ? "none" as const : "unknown" as const;
  const responseState = required ? "awaiting_response" as const : "unknown" as const;
  const identity = {
    findingId: finding.findingId, findingContentHash: finding.contentHash,
    direction, responseExpectation, responseState,
    validatorMethod: "deterministic" as const,
    validatorVersion: FINDING_COMMUNICATION_VALIDATOR_VERSION,
  };
  return {
    findingId: finding.findingId, direction, responseExpectation, responseState,
    validatorMethod: identity.validatorMethod, validatorVersion: identity.validatorVersion,
    contentHash: sha256Value(identity), createdAt: finding.createdAt,
  };
}

function requireCompatibleRelation(
  kind: ExtractionFindingRelation["kind"], from: SemanticFinding,
  target: PriorFindingRelationCandidate, context: FindingCommunicationContext,
): void {
  if (kind === "responds_to") {
    if (target.kind !== "explicit_request" || context.direction !== "outgoing") {
      throw new Error("response relation is incompatible with its findings");
    }
    return;
  }
  if (kind === "resolves") {
    const targetKinds = new Set(["explicit_request", "user_commitment", "other_commitment", "open_loop"]);
    const sourceKinds = new Set(["acceptance", "refusal", "cancellation", "project_update", "supersession"]);
    if (!targetKinds.has(target.kind) || !sourceKinds.has(from.kind)) {
      throw new Error("resolution relation is incompatible with its findings");
    }
    return;
  }
  if (!["supersession", "reschedule", "cancellation"].includes(from.kind)) {
    throw new Error("supersession relation is incompatible with its findings");
  }
}
