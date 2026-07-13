import type { DerivedStateRecord, OperationalStore } from "../db/store";
import { sha256Value } from "../util/hashing";

export type SubjectLinkBasis = "explicit_config" | "reviewed";

export class SubjectLinkStore {
  constructor(private readonly store: OperationalStore) {}

  linkIMessageConversationToPerson(input: {
    sourceId: string;
    conversationId: string;
    personId: string;
    basis: SubjectLinkBasis;
    participantSetHash?: string;
    createdAt?: string;
  }): string {
    requireInternalConversationId(input.conversationId);
    requireCanonicalPersonId(input.personId);
    const person = this.store.getCurrentDerivedState("person_state", input.personId);
    if (!person) throw new Error("current canonical person state not found");

    const db = this.store.open();
    try {
      const conversation = currentConversation(db, input.sourceId, input.conversationId);
      if (!conversation) throw new Error("ingested Messages conversation not found");
      if (input.participantSetHash && input.participantSetHash !== conversation.participant_set_hash) {
        throw new Error("Messages conversation participants changed; reload before linking");
      }
      const identity = {
        fromType: "imessage_conversation",
        fromSourceId: input.sourceId,
        fromId: input.conversationId,
        relationship: "concerns",
        toType: "person",
        toId: input.personId,
        sourceHash: conversation.participant_set_hash,
      } as const;
      const linkId = `link_${sha256Value(identity).slice("sha256:".length, "sha256:".length + 24)}`;
      db.query(`
        INSERT OR IGNORE INTO subject_links (
          link_id, from_type, from_source_id, from_id, relationship,
          to_type, to_id, basis, confidence, source_hash, created_at
        ) VALUES (?, 'imessage_conversation', ?, ?, 'concerns', 'person', ?, ?, 1, ?, ?)
      `).run(
        linkId, input.sourceId, input.conversationId, input.personId, input.basis,
        conversation.participant_set_hash, input.createdAt ?? new Date().toISOString(),
      );
      return linkId;
    } finally {
      db.close();
    }
  }

  currentIMessageConversationParticipantSetHash(input: {
    sourceId: string; conversationId: string;
  }): string {
    requireInternalConversationId(input.conversationId);
    const db = this.store.open();
    try {
      const conversation = currentConversation(db, input.sourceId, input.conversationId);
      if (!conversation) throw new Error("ingested Messages conversation not found");
      return conversation.participant_set_hash;
    } finally { db.close(); }
  }

  linkedPeopleForIMessageConversation(input: {
    sourceId: string;
    conversationId: string;
  }): DerivedStateRecord[] {
    requireInternalConversationId(input.conversationId);
    const db = this.store.open();
    let personIds: string[];
    try {
      personIds = db.query<{ to_id: string }, [string, string]>(`
        SELECT DISTINCT links.to_id
        FROM subject_links links
        JOIN imessage_conversations conversation
          ON conversation.source_id = links.from_source_id
         AND conversation.conversation_id = links.from_id
         AND conversation.participant_set_hash = links.source_hash
        WHERE links.from_type = 'imessage_conversation'
          AND links.from_source_id = ?
          AND links.from_id = ?
          AND links.relationship = 'concerns'
          AND links.to_type = 'person'
        ORDER BY links.to_id
      `).all(input.sourceId, input.conversationId).map((row) => row.to_id);
    } finally {
      db.close();
    }
    return personIds.flatMap((personId) => {
      const state = this.store.getCurrentDerivedState("person_state", personId);
      return state ? [state] : [];
    });
  }
}

function currentConversation(db: ReturnType<OperationalStore["open"]>, sourceId: string, conversationId: string): {
  participant_set_hash: string;
} | undefined {
  return db.query<{ participant_set_hash: string }, [string, string]>(`
    SELECT participant_set_hash FROM imessage_conversations
    WHERE source_id = ? AND conversation_id = ?
  `).get(sourceId, conversationId) ?? undefined;
}

function requireInternalConversationId(value: string): void {
  if (!/^imchat_[a-f0-9]{64}$/.test(value)) throw new Error("invalid internal Messages conversation ID");
}

function requireCanonicalPersonId(value: string): void {
  if (!/^person_[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid canonical person ID");
}
