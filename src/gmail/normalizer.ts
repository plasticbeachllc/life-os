import { htmlToText } from "html-to-text";

import type { GmailApiMessage, GmailPayloadPart } from "../adapters/gmail";
import { sha256Value, sha256Text } from "../util/hashing";

export const gmailNormalizerVersion = "gmail-normalizer-v1";

export interface NormalizedGmailMessage {
  messageId: string;
  threadId: string;
  internalDate: string;
  labelIds: string[];
  fromAddress: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string | null;
  rfcMessageId: string | null;
  normalizedBody: string;
  authoredBody: string;
  quotedBody: string;
  headersHash: string;
  normalizedBodyHash: string;
  authoredBodyHash: string;
  quotedBodyHash: string;
  contentHash: string;
}

export function normalizeGmailMessage(message: GmailApiMessage): NormalizedGmailMessage {
  if (!message.id || !message.threadId) throw new Error("Gmail message requires id and threadId");
  const headers = headerMap(message.payload);
  const plainParts: string[] = [];
  const htmlParts: string[] = [];
  collectBodyParts(message.payload, plainParts, htmlParts);
  const selectedBody = plainParts.some((part) => part.trim())
    ? plainParts.join("\n\n")
    : htmlParts.map((part) => htmlToText(part, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }] })).join("\n\n");
  const normalizedBody = normalizeText(selectedBody || message.snippet || "");
  const { authoredBody, quotedBody } = separateQuotedContent(normalizedBody);
  const selectedHeaders = {
    from: firstHeader(headers, "from"), to: allHeaders(headers, "to"),
    cc: allHeaders(headers, "cc"), subject: firstHeader(headers, "subject"),
    messageId: firstHeader(headers, "message-id"), date: firstHeader(headers, "date"),
  };
  const headersHash = sha256Value(selectedHeaders);
  const normalizedBodyHash = sha256Text(normalizedBody);
  const authoredBodyHash = sha256Text(authoredBody);
  const quotedBodyHash = sha256Text(quotedBody);
  const contentHash = sha256Value({
    messageId: message.id, threadId: message.threadId,
    internalDate: message.internalDate ?? "", headersHash,
    normalizedBodyHash, authoredBodyHash, quotedBodyHash,
    normalizerVersion: gmailNormalizerVersion,
  });
  return {
    messageId: message.id, threadId: message.threadId,
    internalDate: message.internalDate ?? "0", labelIds: [...(message.labelIds ?? [])].sort(),
    fromAddress: selectedHeaders.from,
    toAddresses: selectedHeaders.to, ccAddresses: selectedHeaders.cc,
    subject: selectedHeaders.subject, rfcMessageId: selectedHeaders.messageId,
    normalizedBody, authoredBody, quotedBody, headersHash,
    normalizedBodyHash, authoredBodyHash, quotedBodyHash, contentHash,
  };
}

function collectBodyParts(part: GmailPayloadPart | undefined, plain: string[], html: string[]): void {
  if (!part) return;
  if (!part.filename && part.body?.data) {
    const decoded = decodeBase64Url(part.body.data);
    if (part.mimeType === "text/plain") plain.push(decoded);
    if (part.mimeType === "text/html") html.push(decoded);
  }
  for (const child of part.parts ?? []) collectBodyParts(child, plain, html);
}

function headerMap(payload: GmailPayloadPart | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const header of payload?.headers ?? []) {
    if (!header.name || header.value === undefined) continue;
    const key = header.name.toLowerCase();
    result.set(key, [...(result.get(key) ?? []), header.value]);
  }
  return result;
}

function firstHeader(headers: Map<string, string[]>, name: string): string | null {
  return headers.get(name)?.[0] ?? null;
}

function allHeaders(headers: Map<string, string[]>, name: string): string[] {
  return headers.get(name) ?? [];
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n").trim();
}

function separateQuotedContent(body: string): { authoredBody: string; quotedBody: string } {
  const lines = body.split("\n");
  const boundary = lines.findIndex((line, index) =>
    /^>/.test(line)
    || /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/i.test(line.trim())
    || (/^On .+wrote:$/i.test(line.trim()) && index > 0),
  );
  if (boundary === -1) return { authoredBody: body, quotedBody: "" };
  return {
    authoredBody: lines.slice(0, boundary).join("\n").trim(),
    quotedBody: lines.slice(boundary).join("\n").trim(),
  };
}
