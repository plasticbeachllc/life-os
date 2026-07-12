import { clearChatSession, currentChatSession } from "$lib/server/chat-session";
import { releaseCodexSessionIfStarted } from "$lib/server/codex/app-server";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const DELETE: RequestHandler = async ({ cookies }) => {
	const sessionId = currentChatSession(cookies);
	if (sessionId) await releaseCodexSessionIfStarted(sessionId);
	clearChatSession(cookies);
	return json({ released: Boolean(sessionId) });
};
