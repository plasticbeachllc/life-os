import type { ChatMessage } from "./types";

export const initialMessages: ChatMessage[] = [
	{
		id: "message_welcome",
		role: "agent",
		body: "I’m connected to your local LifeOS read models. Ask what needs attention, or select an Inbox item to discuss it. Writes remain disabled in this first live slice.",
		createdAt: "Ready",
	},
];
