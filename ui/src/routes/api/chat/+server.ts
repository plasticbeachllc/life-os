import { parseChatInput } from "$lib/server/chat-input";
import { getCodexAppServerClient } from "$lib/server/codex/app-server";
import { getNotificationSummary } from "$lib/server/notification-summaries";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "Request body must be JSON" }, { status: 400 });
	}

	const input = parseChatInput(body);
	if ("error" in input) return json(input, { status: 400 });

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const emit = (event: Record<string, unknown>) => {
				controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
			};

			const operation = input.intent === "summarize_context"
				? getNotificationSummary(input.notificationId!).then((summary) => {
					for (const [index, sentence] of summary.sentences.entries()) {
						emit({ type: "message", text: sentence, index });
					}
				})
				: getCodexAppServerClient().streamTurn({
				message: input.message,
				conversationId: input.conversationId,
				...(input.context ? { context: input.context } : {}),
				onDelta: (delta) => emit({ type: "delta", delta }),
			});
			void operation.then(() => {
				emit({ type: "done" });
				controller.close();
			}).catch((error: unknown) => {
				emit({ type: "error", error: safeError(error) });
				controller.close();
			});
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
};

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : "LifeOS chat is unavailable";
	if (message.includes("already responding")) return "LifeOS is already responding to another message.";
	if (message.includes("logged in using ChatGPT")) return "Codex must be logged in using ChatGPT.";
	if (message.includes("not installed")) return "Codex CLI is not installed or is not on PATH.";
	return "The local Codex App Server is unavailable. Check the LifeOS server logs and try again.";
}
