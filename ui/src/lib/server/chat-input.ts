import type { ChatContext } from "$lib/server/codex/app-server";

const maxMessageCharacters = 4_000;
const maxContextCharacters = 500;
const contextKinds = new Set(["email", "calendar", "proposal", "system", "task"]);

export type ParsedChatInput = {
	message: string;
	context?: ChatContext;
	intent: "chat" | "summarize_context";
	conversationId: string;
	notificationId?: string;
};

export function parseChatInput(value: unknown): ParsedChatInput | { error: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Invalid request body" };
	const record = value as Record<string, unknown>;
	if (typeof record.conversationId !== "string" || !/^conversation_[A-Za-z0-9_-]{1,100}$/.test(record.conversationId)) {
		return { error: "Invalid conversation ID" };
	}
	if (record.intent === "summarize_context") {
		if (Object.keys(record).some((key) => !["intent", "context", "conversationId", "notificationId"].includes(key))) {
			return { error: "Invalid summary request" };
		}
		if (typeof record.notificationId !== "string" || !/^ui_[a-f0-9]{20}$/.test(record.notificationId)) {
			return { error: "Invalid notification ID" };
		}
		const context = parseContext(record.context);
		if ("error" in context) return context;
		return { intent: "summarize_context", message: summaryPrompt(context.kind), context,
			conversationId: record.conversationId, notificationId: record.notificationId };
	}
	if (record.intent !== undefined
		|| Object.keys(record).some((key) => !["message", "context", "conversationId"].includes(key))) {
		return { error: "Invalid request body" };
	}
	if (typeof record.message !== "string") return { error: "Message is required" };
	const message = record.message.trim();
	if (!message || message.length > maxMessageCharacters) {
		return { error: `Message must contain 1-${maxMessageCharacters} characters` };
	}

	if (record.context === undefined || record.context === null) {
		return { intent: "chat", message, conversationId: record.conversationId };
	}
	const context = parseContext(record.context);
	if ("error" in context) return context;
	return { intent: "chat", message, context, conversationId: record.conversationId };
}

function parseContext(value: unknown): ChatContext | { error: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Invalid Inbox context" };
	const context = value as Record<string, unknown>;
	if (Object.keys(context).some((key) => !["kind", "category", "title", "summary", "detail", "suggestedAction", "agentSummary"].includes(key))) {
		return { error: "Invalid Inbox context" };
	}
	if (typeof context.kind !== "string" || !contextKinds.has(context.kind)
		|| typeof context.title !== "string" || typeof context.summary !== "string") {
		return { error: "Invalid Inbox context" };
	}
	if (context.title.length > maxContextCharacters || context.summary.length > maxContextCharacters) {
		return { error: "Inbox context is too long" };
	}
	if (context.category !== undefined && !["needs_you", "activity", "approvals"].includes(String(context.category))) {
		return { error: "Invalid Inbox context" };
	}
	if ((context.detail !== undefined && (typeof context.detail !== "string" || context.detail.length > maxContextCharacters))
		|| (context.suggestedAction !== undefined
			&& (typeof context.suggestedAction !== "string" || context.suggestedAction.length > 120))) {
		return { error: "Invalid Inbox context" };
	}
	let agentSummary: string[] | undefined;
	if (context.agentSummary !== undefined) {
		if (!Array.isArray(context.agentSummary) || context.agentSummary.length > 4
			|| context.agentSummary.some((item) => typeof item !== "string" || item.length > maxContextCharacters)) {
			return { error: "Invalid Inbox context" };
		}
		agentSummary = context.agentSummary as string[];
	}
	return { kind: context.kind as ChatContext["kind"],
		...(context.category ? { category: context.category as ChatContext["category"] } : {}),
		title: context.title, summary: context.summary,
		...(context.detail ? { detail: context.detail as string } : {}),
		...(context.suggestedAction ? { suggestedAction: context.suggestedAction as string } : {}),
		...(agentSummary ? { agentSummary } : {}) };
}

function summaryPrompt(kind: ChatContext["kind"]): string {
	return `Load the pre-generated grounded summary for the selected ${kind} Inbox item.`;
}
