import { getCodexAppServerClient } from "$lib/server/codex/app-server";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	try {
		return json(await getCodexAppServerClient().status(), {
			headers: { "cache-control": "no-store" },
		});
	} catch (error) {
		return json({
			connected: false,
			error: publicStatusError(error),
		}, { status: 503, headers: { "cache-control": "no-store" } });
	}
};

function publicStatusError(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (message.includes("logged in using ChatGPT")) return "Codex must be logged in using ChatGPT.";
	if (message.includes("not installed")) return "Codex CLI is not installed or is not on PATH.";
	return "The local Codex App Server is unavailable.";
}
