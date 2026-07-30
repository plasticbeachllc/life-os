import type { Cookies } from "@sveltejs/kit";

import {
	currentChatSession,
	validateFeedbackCapability,
} from "./chat-session";
import { isSameOriginFeedbackRequest } from "./feedback-security";

export async function parseBrowserActionRequest(input: {
	request: Request;
	url: URL;
	keys: readonly string[];
}): Promise<Record<string, string>> {
	if (!isSameOriginFeedbackRequest(input.request, input.url)) throw new Error("cross-origin action request");
	const value: unknown = await input.request.json();
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid action request");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== input.keys.length
		|| Object.keys(record).some((key) => !input.keys.includes(key))
		|| input.keys.some((key) => typeof record[key] !== "string")) {
		throw new Error("invalid action request");
	}
	return record as Record<string, string>;
}

export function requireBrowserActionSubject(input: {
	cookies: Cookies;
	csrfToken: string;
	subjectUiId: string;
	subjectKind: "attention" | "proposal" | "action";
}): string {
	const sessionId = currentChatSession(input.cookies);
	if (!validateFeedbackCapability({
		sessionId,
		token: input.csrfToken,
		subjectUiId: input.subjectUiId,
		subjectKind: input.subjectKind,
	})) {
		throw new Error("browser action capability mismatch");
	}
	return sessionId!;
}
