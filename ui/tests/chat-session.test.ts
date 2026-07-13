import { describe, expect, test } from "bun:test";
import type { Cookies } from "@sveltejs/kit";

import { clearChatSession, currentChatSession, ensureChatSession } from "../src/lib/server/chat-session";

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
});
