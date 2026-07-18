import { randomBytes, randomUUID } from "node:crypto";

import type { Cookies } from "@sveltejs/kit";

const cookieName = "life_os_chat_session";
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const feedbackTokenPattern = /^[0-9a-f]{64}$/;
const feedbackCapabilityTtlMs = 8 * 60 * 60 * 1000;
const maxFeedbackSessions = 1_000;
const feedbackCapabilities = new Map<string, {
	token: string; subjects: Map<string, "finding" | "proposal" | "attention">; expiresAt: number;
}>();
const workspaceRefreshCapabilities = new Map<string, { token: string; expiresAt: number }>();

export function ensureChatSession(cookies: Cookies): string {
	const existing = cookies.get(cookieName);
	if (existing && sessionPattern.test(existing)) return existing;
	const sessionId = randomUUID();
	cookies.set(cookieName, sessionId, {
		path: "/",
		httpOnly: true,
		sameSite: "strict",
		secure: false,
	});
	return sessionId;
}

export function currentChatSession(cookies: Cookies): string | undefined {
	const value = cookies.get(cookieName);
	return value && sessionPattern.test(value) ? value : undefined;
}

export function clearChatSession(cookies: Cookies): void {
  const sessionId = currentChatSession(cookies);
  if (sessionId) {
    feedbackCapabilities.delete(sessionId);
    workspaceRefreshCapabilities.delete(sessionId);
  }
	cookies.delete(cookieName, { path: "/" });
}

export function issueWorkspaceRefreshCapability(input: { sessionId: string; now?: Date }): string {
  if (!sessionPattern.test(input.sessionId)) throw new Error("invalid refresh session");
  const now = (input.now ?? new Date()).getTime();
  pruneWorkspaceRefreshCapabilities(now);
  const token = randomBytes(32).toString("hex");
  workspaceRefreshCapabilities.set(input.sessionId, { token, expiresAt: now + feedbackCapabilityTtlMs });
  return token;
}

export function validateWorkspaceRefreshCapability(input: {
  sessionId: string | undefined; token: string; now?: Date;
}): boolean {
  const now = (input.now ?? new Date()).getTime();
  pruneWorkspaceRefreshCapabilities(now);
  if (!input.sessionId || !sessionPattern.test(input.sessionId) || !feedbackTokenPattern.test(input.token)) return false;
  const capability = workspaceRefreshCapabilities.get(input.sessionId);
  return Boolean(capability && capability.expiresAt > now && capability.token === input.token);
}

export function issueFeedbackCapability(input: {
	sessionId: string; subjects: Array<{ id: string; kind: "finding" | "proposal" | "attention" }>; now?: Date;
}): string {
	if (!sessionPattern.test(input.sessionId)) throw new Error("invalid feedback session");
	pruneFeedbackCapabilities((input.now ?? new Date()).getTime());
	const token = randomBytes(32).toString("hex");
	feedbackCapabilities.set(input.sessionId, {
		token, subjects: new Map(input.subjects.map((subject) => [subject.id, subject.kind])),
		expiresAt: (input.now ?? new Date()).getTime() + feedbackCapabilityTtlMs,
	});
	return token;
}

export function validateFeedbackCapability(input: {
	sessionId: string | undefined; token: string; subjectUiId: string;
	subjectKind: "finding" | "proposal" | "attention"; now?: Date;
}): boolean {
	const now = (input.now ?? new Date()).getTime();
	pruneFeedbackCapabilities(now);
	if (!input.sessionId || !sessionPattern.test(input.sessionId)
		|| !feedbackTokenPattern.test(input.token)) return false;
	const capability = feedbackCapabilities.get(input.sessionId);
	return Boolean(capability && capability.expiresAt > now
		&& capability.token === input.token
		&& capability.subjects.get(input.subjectUiId) === input.subjectKind);
}

function pruneFeedbackCapabilities(now: number): void {
	for (const [sessionId, capability] of feedbackCapabilities) {
		if (capability.expiresAt <= now) feedbackCapabilities.delete(sessionId);
	}
	while (feedbackCapabilities.size >= maxFeedbackSessions) {
		const oldest = feedbackCapabilities.keys().next().value as string | undefined;
		if (!oldest) break;
		feedbackCapabilities.delete(oldest);
	}
}

function pruneWorkspaceRefreshCapabilities(now: number): void {
  for (const [sessionId, capability] of workspaceRefreshCapabilities) {
    if (capability.expiresAt <= now) workspaceRefreshCapabilities.delete(sessionId);
  }
  while (workspaceRefreshCapabilities.size >= maxFeedbackSessions) {
    const oldest = workspaceRefreshCapabilities.keys().next().value as string | undefined;
    if (!oldest) break;
    workspaceRefreshCapabilities.delete(oldest);
  }
}
