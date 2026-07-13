export const sourceEventProviders = [
  "gmail", "imessage", "telegram", "calendar", "obsidian",
] as const;
export type SourceEventProvider = typeof sourceEventProviders[number];

export type SourceEventKind = "message" | "calendar_event" | "canonical_note";
export type SourceEventDirection = "incoming" | "outgoing" | "draft" | "system" | "unknown";

export interface AppendSourceEventInput {
  provider: SourceEventProvider;
  eventKind: SourceEventKind;
  direction: SourceEventDirection;
  sourceScopeId: string;
  sourceRecordId: string;
  containerId: string;
  sourceVersionHash: string;
  occurredAt: string;
  observedAt: string;
  contentAvailable: boolean;
}

export interface SourceEvent {
  eventId: string;
  streamSequence: number;
  provider: SourceEventProvider;
  eventKind: SourceEventKind;
  direction: SourceEventDirection;
  sourceScopeHash: string;
  sourceRecordHash: string;
  containerHash: string;
  sourceVersionHash: string;
  previousEventId?: string;
  occurredAt: string;
  observedAt: string;
  contentAvailable: boolean;
  streamVersion: string;
}

export interface SourceEventSummary {
  total: number;
  byProvider: Record<SourceEventProvider, number>;
  byKind: Partial<Record<SourceEventKind, number>>;
  byDirection: Partial<Record<SourceEventDirection, number>>;
  earliestOccurredAt: string | null;
  latestOccurredAt: string | null;
}
