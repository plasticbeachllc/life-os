import type { AttentionReviewItem } from "../attention/review";
import type { OperationalStore } from "../db/store";
import { gmailParticipantLabels } from "../gmail/identity";
import { FindingStore } from "../findings/store";

export interface AttentionSourceContext {
  findingStatements: string[];
  participantLabels: string[];
  sourceKind: "gmail" | "messages" | "mixed" | "unknown";
  canOpenEmail: boolean;
}

export function attentionSourceContext(
  store: OperationalStore, item: AttentionReviewItem,
): AttentionSourceContext {
  const findings = item.findingIds.flatMap((findingId) => {
    const finding = new FindingStore(store).get(findingId);
    return finding ? [finding] : [];
  });
  const gmailFindingIds = findings
    .filter((finding) => finding.sourceType === "gmail_extraction")
    .map((finding) => finding.findingId);
  const participantLabels = gmailFindingIds.length > 0
    ? gmailLabelsForFindings(store, gmailFindingIds)
    : [];
  const sourceTypes = new Set(findings.map((finding) => finding.sourceType));
  return {
    findingStatements: findings.map((finding) => finding.statement).slice(0, 10),
    participantLabels,
    sourceKind: sourceTypes.size > 1 ? "mixed"
      : sourceTypes.has("gmail_extraction") ? "gmail"
        : sourceTypes.has("imessage_extraction") ? "messages" : "unknown",
    canOpenEmail: gmailFindingIds.length > 0,
  };
}

export function gmailThreadUrlForAttention(
  store: OperationalStore, item: AttentionReviewItem,
): string | undefined {
  const db = store.open();
  try {
    for (const findingId of item.findingIds) {
      const row = db.query<{ thread_id: string }, [string]>(`
        SELECT message.thread_id
        FROM findings finding
        JOIN gmail_extractions extraction
          ON finding.source_type = 'gmail_extraction'
         AND extraction.extraction_id = finding.source_extraction_id
        JOIN gmail_messages message
          ON message.account_id = extraction.account_id
         AND message.message_id = extraction.message_id
        WHERE finding.finding_id = ?
      `).get(findingId);
      if (row && /^[A-Za-z0-9_-]{1,200}$/.test(row.thread_id)) {
        return `https://mail.google.com/mail/#all/${row.thread_id}`;
      }
    }
    return undefined;
  } finally {
    db.close();
  }
}

function gmailLabelsForFindings(store: OperationalStore, findingIds: string[]): string[] {
  const db = store.open();
  try {
    const labels: string[] = [];
    const addresses: string[] = [];
    for (const findingId of findingIds) {
      const row = db.query<{
        from_address: string | null; to_addresses_json: string; cc_addresses_json: string;
      }, [string]>(`
        SELECT message.from_address, message.to_addresses_json, message.cc_addresses_json
        FROM findings finding
        JOIN gmail_extractions extraction
          ON finding.source_type = 'gmail_extraction'
         AND extraction.extraction_id = finding.source_extraction_id
        JOIN gmail_messages message
          ON message.account_id = extraction.account_id
         AND message.message_id = extraction.message_id
        WHERE finding.finding_id = ?
      `).get(findingId);
      if (!row) continue;
      const headers = [
        row.from_address, ...stringArray(row.to_addresses_json), ...stringArray(row.cc_addresses_json),
      ];
      labels.push(...gmailParticipantLabels(headers));
      addresses.push(...headers.flatMap((header) => header ? emailAddresses(header) : []));
    }
    for (const state of store.listCurrentDerivedStates("person_state")) {
      const emails = Array.isArray(state.content.emails) ? state.content.emails.map(String) : [];
      if (!emails.some((email) => addresses.includes(email.toLowerCase()))) continue;
      const displayName = String(state.content.display_name ?? "").replace(/\s+/g, " ").trim();
      if (displayName && !displayName.includes("@") && displayName.length <= 100) labels.push(displayName);
    }
    return [...new Set(labels)].slice(0, 10);
  } finally {
    db.close();
  }
}

function emailAddresses(value: string): string[] {
  return [...value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .map((match) => match[0]!.toLowerCase());
}

function stringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
