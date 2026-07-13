import type { ChatMessage } from "./types";

export const initialMessages: ChatMessage[] = [
	{
		id: "message_welcome",
		role: "agent",
		body: "I can help you see what needs attention and talk through anything in your Inbox. I’m read-only here, so I can review and explain, but I won’t make changes.",
		createdAt: "Ready",
	},
];
