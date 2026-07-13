import type { IMessageConversationSelection } from "../adapters/imessage";
import { SubjectLinkStore, type SubjectLinkBasis } from "../context/subject-links";
import type { OperationalStore } from "../db/store";
import { internalIMessageConversationId } from "../imessage/normalizer";

export function linkIMessageConversationToPerson(input: {
  store: OperationalStore;
  sourceId: string;
  sourceConversationId: string;
  personId: string;
  selection: IMessageConversationSelection;
  basis?: SubjectLinkBasis;
}): { linked: true; linkId: string; personId: string } {
  input.store.migrate();
  assertSelected(input.sourceConversationId, input.selection);
  if (!input.store.getCurrentDerivedState("person_state", input.personId)) {
    throw new Error("current canonical person state not found");
  }
  const conversationId = internalIMessageConversationId(input.sourceConversationId);
  const links = new SubjectLinkStore(input.store);
  const participantSetHash = links.currentIMessageConversationParticipantSetHash({
    sourceId: input.sourceId, conversationId,
  });
  const linkId = links.linkIMessageConversationToPerson({
    sourceId: input.sourceId,
    conversationId,
    personId: input.personId,
    basis: input.basis ?? "reviewed",
    participantSetHash,
  });
  return { linked: true, linkId, personId: input.personId };
}

function assertSelected(value: string, selection: IMessageConversationSelection): void {
  const selected = selection.mode === "allowlist"
    ? selection.conversationIds.includes(value)
    : !selection.conversationIds.includes(value);
  if (!selected) throw new Error("Messages conversation is outside the configured selection");
}
