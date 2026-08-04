import type { AttentionReviewItem } from "../attention/review";
import type { OperationalStore } from "../db/store";
import { gmailParticipantLabels } from "../gmail/identity";
import { FindingStore } from "../findings/store";

export interface AttentionSourceContext {
  findingStatements: string[];
  participantLabels: string[];
  sourceKind: "gmail" | "messages" | "mixed" | "unknown";
  canOpenEmail: boolean;
  emailDraftKind?: "reply" | "follow_up";
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
    ...(gmailFindingIds.length > 0 && ["response_needed", "response_overdue"].includes(item.type)
      ? { emailDraftKind: "reply" as const }
      : gmailFindingIds.length > 0 && item.type === "waiting_on_other"
        ? { emailDraftKind: "follow_up" as const } : {}),
  };
}

export function gmailDraftSourceForAttention(
  store: OperationalStore, item: AttentionReviewItem,
): {
  accountId: string; threadId: string; threadStateHash: string;
  findingStatements: string[]; participantLabels: string[];
} | undefined {
  const db = store.open();
  try {
    const rows: Array<{ account_id: string; thread_id: string; thread_state_hash: string; statement: string }> = [];
    for (const findingId of item.findingIds) {
      const row = db.query<{
        account_id: string; thread_id: string; thread_state_hash: string; statement: string;
      }, [string]>(`
        SELECT extraction.account_id, message.thread_id, thread.thread_state_hash, finding.statement
        FROM findings finding
        JOIN gmail_extractions extraction
          ON finding.source_type = 'gmail_extraction'
         AND extraction.extraction_id = finding.source_extraction_id
        JOIN gmail_messages message
          ON message.account_id = extraction.account_id
         AND message.message_id = extraction.message_id
        JOIN gmail_threads thread
          ON thread.account_id = message.account_id AND thread.thread_id = message.thread_id
        WHERE finding.finding_id = ?
      `).get(findingId);
      if (row) rows.push(row);
    }
    if (rows.length === 0) return undefined;
    const sourceKeys = new Set(rows.map((row) => `${row.account_id}:${row.thread_id}:${row.thread_state_hash}`));
    if (sourceKeys.size !== 1) return undefined;
    const first = rows[0]!;
    return {
      accountId: first.account_id, threadId: first.thread_id,
      threadStateHash: first.thread_state_hash,
      findingStatements: [...new Set(rows.map((row) => row.statement))].slice(0, 10),
      participantLabels: gmailLabelsForFindings(store, item.findingIds),
    };
  } finally {
    db.close();
  }
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
