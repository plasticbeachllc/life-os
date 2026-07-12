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
  const linkId = new SubjectLinkStore(input.store).linkIMessageConversationToPerson({
    sourceId: input.sourceId,
    conversationId: internalIMessageConversationId(input.sourceConversationId),
    personId: input.personId,
    basis: input.basis ?? "reviewed",
  });
  return { linked: true, linkId, personId: input.personId };
}

function assertSelected(value: string, selection: IMessageConversationSelection): void {
  const selected = selection.mode === "allowlist"
    ? selection.conversationIds.includes(value)
    : !selection.conversationIds.includes(value);
  if (!selected) throw new Error("Messages conversation is outside the configured selection");
}
