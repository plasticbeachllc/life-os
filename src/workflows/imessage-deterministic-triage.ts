import type { IMessageConversationSelection, IMessageSourceAdapter } from "../adapters/imessage";
import type { OperationalStore } from "../db/store";
import { IMessageStore } from "../imessage/store";
import { newId } from "../util/ids";
import { refetchIMessage } from "./imessage-refetch";
import { WorkRepository } from "../work/repository";

export const IMESSAGE_TRIAGE_RULE_VERSION = "imessage-service-triage-v1";

export interface IMessageTriageReport {
  scanned: number;
  triaged: number;
  remainingForModel: number;
  byRule: Record<string, number>;
  modelCalls: 0;
  proposals: 0;
  mutations: 0;
}

export async function triageIMessageServiceConversations(input: {
  adapter: IMessageSourceAdapter; store: OperationalStore; sourceId: string;
  selection: IMessageConversationSelection; limit: number;
}): Promise<IMessageTriageReport> {
  input.store.migrate();
  const imessageStore = new IMessageStore(input.store);
  const workRepository = new WorkRepository(input.store);
  const candidates = workRepository.listReady({
    workflow: "imessage_extraction", subjectSourceId: input.sourceId, limit: input.limit,
  });
  const report: IMessageTriageReport = {
    scanned: candidates.length, triaged: 0, remainingForModel: 0,
    byRule: {}, modelCalls: 0, proposals: 0, mutations: 0,
  };
  for (const candidate of candidates) {
    const source = await refetchIMessage({
      adapter: input.adapter, store: input.store, sourceId: input.sourceId,
      messageId: candidate.anchorId, selection: input.selection,
    });
    const result = classifyServiceMessage(source.transientText, evidenceId(source.messageId, source.sourceHash));
    if (!result) {
      report.remainingForModel += 1;
      continue;
    }
    const leaseOwner = `triage_${newId("work")}`;
    const claimed = workRepository.claimExact({
      workId: candidate.workId, leaseOwner, leaseDurationMs: 5 * 60 * 1000,
    });
    if (!claimed) continue;
    const createdAt = new Date().toISOString();
    imessageStore.saveDeterministicTriage({
      triageId: newId("triage"), sourceId: input.sourceId,
      messageId: claimed.anchorId, sourceHash: claimed.sourceHash,
      conversationId: claimed.subjectId,
      conversationStateHash: claimed.containerHash,
      classification: result.classification, output: result.output,
      ruleVersion: IMESSAGE_TRIAGE_RULE_VERSION, createdAt,
      workId: claimed.workId, leaseOwner,
    });
    report.triaged += 1;
    report.byRule[result.rule] = (report.byRule[result.rule] ?? 0) + 1;
  }
  return report;
}

function classifyServiceMessage(text: string, evidence: string): {
  rule: string; classification: "actionable" | "reference_only" | "ignore";
  output: Record<string, unknown>;
} | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (/\border\b.{0,100}\bready for pickup\b|\byour order is ready for pickup\b/i.test(normalized)) {
    return {
      rule: "order_ready_for_pickup", classification: "actionable",
      output: {
        classification: "actionable", summary: "A new order is ready for pickup.",
        items: [{
          kind: "explicit_request", statement: "Pick up the newly ready order.",
          evidenceIds: [evidence], evidenceCount: 1, confidence: 0.99,
          owner: "user", dueDate: null, responseNeeded: false,
          ambiguities: ["The pickup location and deadline may require checking the order details."],
        }],
        unresolved: ["Pickup location and any pickup deadline."],
        promptInjectionDetected: false,
      },
    };
  }
  if (/(?:verification|security|authentication|login) code\b|\bis your .{0,50}code\b/i.test(normalized)
    && /\bcode\b/i.test(normalized)) {
    return {
      rule: "verification_code", classification: "ignore",
      output: {
        classification: "ignore",
        summary: "A one-time account verification code was received; no durable follow-up was extracted.",
        items: [], unresolved: [], promptInjectionDetected: false,
      },
    };
  }
  if (/thanks for (?:joining|signing up)|(?:successfully )?(?:subscribed|enrolled)/i.test(normalized)
    && /(text|messag|reply stop|opt out)/i.test(normalized)) {
    return {
      rule: "messaging_enrollment", classification: "reference_only",
      output: {
        classification: "reference_only",
        summary: "Enrollment in a service's text notifications was confirmed.",
        items: [], unresolved: [], promptInjectionDetected: false,
      },
    };
  }
  if (/\btext stop to (?:opt out|end)\b/i.test(normalized)
    && !/(appointment|reservation|booked|delivery|ready)/i.test(normalized)) {
    return {
      rule: "routine_service_notice", classification: "reference_only",
      output: {
        classification: "reference_only",
        summary: "A routine service notification was received with opt-out instructions.",
        items: [], unresolved: [], promptInjectionDetected: false,
      },
    };
  }
  return undefined;
}

function evidenceId(messageId: string, sourceHash: string): string {
  return `imessage:${messageId}:${sourceHash}`;
}
