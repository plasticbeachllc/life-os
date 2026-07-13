import type { OperationalStore } from "../db/store";
import type { SourceEvent } from "../events/contract";
import { SourceSubjectLinkRepository } from "../events/subject-links";
import { sha256Value } from "../util/hashing";
import type { ContextCandidate } from "./builder";

export const SOURCE_SUBJECT_CONTEXT_VERSION = "source-subject-context-v1";
const candidatePrefix = "source-subject-context:";

export function sourceSubjectContextCandidate(input: {
  store: OperationalStore; eventId: string; before?: number;
}): ContextCandidate {
  const links = new SourceSubjectLinkRepository(input.store);
  const subjects = links.linkedSubjects(input.eventId);
  const events = subjects.length > 0
    ? links.causalWindow({ eventId: input.eventId, before: input.before ?? 20 })
    : [];
  const states = subjects.map((subject) => {
    const state = input.store.getCurrentDerivedState(`${subject.type}_state`, subject.id);
    if (!state) throw new Error("linked canonical subject state is unavailable");
    return {
      subject, stateId: state.stateId, stateVersion: state.stateVersion,
      dependencyHash: state.dependencyHash ?? state.sourceHashes[0] ?? state.stateId,
    };
  });
  const dependencyHash = sha256Value({
    version: SOURCE_SUBJECT_CONTEXT_VERSION,
    targetEventId: input.eventId,
    subjects: states,
    events: events.map(eventDependency),
  });
  const content = {
    context_kind: "validated_source_subject_history",
    context_dependency_hash: dependencyHash,
    linked_subjects: states.map((state) => ({
      type: state.subject.type, id: state.subject.id,
      state_id: state.stateId, state_version: state.stateVersion,
    })),
    recent_events: events.map((event) => ({
      provider: event.provider, event_kind: event.eventKind, direction: event.direction,
      occurred_at: event.occurredAt, content_available: event.contentAvailable,
    })),
  };
  return {
    id: `${candidatePrefix}${input.eventId}`,
    category: "recent_change", retrievalLevel: 1, content,
    tokenEstimate: Math.ceil(JSON.stringify(content).length / 4),
    relevance: subjects.length > 0 ? 0.75 : 0.35,
    impact: subjects.length > 0 ? 0.65 : 0.2,
    recency: 0.9,
    sourceRefs: [
      input.eventId, dependencyHash,
      ...states.flatMap((state) => [state.stateId, state.dependencyHash]),
      ...events.map((event) => event.eventId),
    ],
  };
}

export function assertSourceSubjectContextCurrent(
  store: OperationalStore, items: unknown[],
): void {
  for (const value of items) {
    if (!value || typeof value !== "object") continue;
    const item = value as Partial<ContextCandidate>;
    if (typeof item.id !== "string" || !item.id.startsWith(candidatePrefix)) continue;
    const eventId = item.id.slice(candidatePrefix.length);
    const preparedHash = field(item.content, "context_dependency_hash");
    let current: ContextCandidate;
    try {
      current = sourceSubjectContextCandidate({ store, eventId });
    } catch {
      throw new Error("validated source subject context changed; prepare extraction again");
    }
    if (!preparedHash || field(current.content, "context_dependency_hash") !== preparedHash) {
      throw new Error("validated source subject context changed; prepare extraction again");
    }
  }
}

function eventDependency(event: SourceEvent): Record<string, unknown> {
  return {
    eventId: event.eventId, provider: event.provider, eventKind: event.eventKind,
    direction: event.direction, occurredAt: event.occurredAt,
    sourceVersionHash: event.sourceVersionHash, contentAvailable: event.contentAvailable,
  };
}

function field(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "string" ? item : undefined;
}
