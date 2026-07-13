import { describe, expect, test } from "bun:test";
import type { Cookies } from "@sveltejs/kit";

import {
	clearChatSession, currentChatSession, ensureChatSession, issueFeedbackCapability,
	validateFeedbackCapability,
} from "../src/lib/server/chat-session";

function cookieJar(): { cookies: Cookies; options: Array<Record<string, unknown>> } {
	const values = new Map<string, string>();
	const options: Array<Record<string, unknown>> = [];
	const cookies = {
		get: (name: string) => values.get(name),
		set: (name: string, value: string, input: Record<string, unknown>) => {
			values.set(name, value);
			options.push(input);
		},
		delete: (name: string) => values.delete(name),
	} as unknown as Cookies;
	return { cookies, options };
}

describe("LifeOS chat sessions", () => {
	test("issues opaque HttpOnly session IDs and keeps browser sessions isolated", () => {
		const first = cookieJar();
		const second = cookieJar();
		const firstId = ensureChatSession(first.cookies);
		const secondId = ensureChatSession(second.cookies);

		expect(firstId).not.toBe(secondId);
		expect(ensureChatSession(first.cookies)).toBe(firstId);
		expect(first.options[0]).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/" });
		expect(currentChatSession(first.cookies)).toBe(firstId);
		clearChatSession(first.cookies);
		expect(currentChatSession(first.cookies)).toBeUndefined();
	});

	test("binds feedback subjects and CSRF token to one expiring session", () => {
		const first = cookieJar(); const second = cookieJar();
		const firstId = ensureChatSession(first.cookies); const secondId = ensureChatSession(second.cookies);
		const now = new Date("2026-07-12T12:00:00.000Z");
		const token = issueFeedbackCapability({ sessionId: firstId,
			subjects: [{ id: "ui_0123456789abcdefabcd", kind: "finding" }], now });
		expect(validateFeedbackCapability({ sessionId: firstId, token,
			subjectUiId: "ui_0123456789abcdefabcd", subjectKind: "finding", now })).toBe(true);
		expect(validateFeedbackCapability({ sessionId: secondId, token,
			subjectUiId: "ui_0123456789abcdefabcd", subjectKind: "finding", now })).toBe(false);
		expect(validateFeedbackCapability({ sessionId: firstId, token,
			subjectUiId: "ui_ffffffffffffffffffff", subjectKind: "finding", now })).toBe(false);
		expect(validateFeedbackCapability({ sessionId: firstId, token,
			subjectUiId: "ui_0123456789abcdefabcd", subjectKind: "proposal", now })).toBe(false);
		expect(validateFeedbackCapability({ sessionId: firstId, token: "0".repeat(64),
			subjectUiId: "ui_0123456789abcdefabcd", subjectKind: "finding", now })).toBe(false);
		expect(validateFeedbackCapability({ sessionId: firstId, token,
			subjectUiId: "ui_0123456789abcdefabcd", subjectKind: "finding",
			now: new Date("2026-07-12T21:00:00.000Z") })).toBe(false);
	});
});
