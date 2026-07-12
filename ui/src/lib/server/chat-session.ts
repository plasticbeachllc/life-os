import { randomUUID } from "node:crypto";

import type { Cookies } from "@sveltejs/kit";

const cookieName = "life_os_chat_session";
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
	cookies.delete(cookieName, { path: "/" });
}
