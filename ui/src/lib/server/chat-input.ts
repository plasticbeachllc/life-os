import type { ChatContext } from "$lib/server/codex/app-server";

const maxMessageCharacters = 4_000;
const maxContextCharacters = 500;

export function parseChatInput(value: unknown): { message: string; context?: ChatContext } | { error: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Invalid request body" };
	const record = value as Record<string, unknown>;
	if (typeof record.message !== "string") return { error: "Message is required" };
	const message = record.message.trim();
	if (!message || message.length > maxMessageCharacters) {
		return { error: `Message must contain 1-${maxMessageCharacters} characters` };
	}

	if (record.context === undefined || record.context === null) return { message };
	if (typeof record.context !== "object" || Array.isArray(record.context)) return { error: "Invalid Inbox context" };
	const context = record.context as Record<string, unknown>;
	if (typeof context.title !== "string" || typeof context.summary !== "string") return { error: "Invalid Inbox context" };
	if (context.title.length > maxContextCharacters || context.summary.length > maxContextCharacters) {
		return { error: "Inbox context is too long" };
	}
	return { message, context: { title: context.title, summary: context.summary } };
}
