import { describe, expect, test } from "bun:test";

import { parseChatInput } from "../src/lib/server/chat-input";
import { conversationBindingKey } from "../src/lib/server/codex/app-server";
import { normalizeSummary, summarySchedulerStatus } from "../src/lib/server/notification-summaries";

describe("LifeOS chat API input", () => {
	test("accepts a bounded message and sanitized Inbox context", () => {
		expect(parseChatInput({
			conversationId: "conversation_email_1",
			message: "  What needs my attention?  ",
			context: { kind: "email", title: "Email needs clarification", summary: "Ownership is unclear." },
		})).toEqual({
			intent: "chat",
			conversationId: "conversation_email_1",
			message: "What needs my attention?",
			context: { kind: "email", title: "Email needs clarification", summary: "Ownership is unclear." },
		});
	});

	test("uses a fixed grounded prompt for automatic context summaries", () => {
		const parsed = parseChatInput({
			intent: "summarize_context",
			conversationId: "conversation_calendar_1",
			notificationId: "ui_0123456789abcdef0123",
			context: { kind: "calendar", title: "Calendar is organized", summary: "Three upcoming events." },
		});

		expect(parsed).toEqual(expect.objectContaining({
			intent: "summarize_context",
			conversationId: "conversation_calendar_1",
			notificationId: "ui_0123456789abcdef0123",
			context: { kind: "calendar", title: "Calendar is organized", summary: "Three upcoming events." },
		}));
		expect("error" in parsed ? "" : parsed.message).toContain("pre-generated grounded summary");
		expect(normalizeSummary(JSON.stringify({
			sentences: ["First grounded point.", "Second action point."],
			actionRequired: true,
		}), true)).toEqual({
			sentences: ["First grounded point.", "Second action point."],
			actionRequired: true,
		});
		expect(() => normalizeSummary(JSON.stringify({
			sentences: ["Only one sentence."], actionRequired: true,
		}), true)).toThrow("2-3 sentences");
		expect(() => normalizeSummary(JSON.stringify({
			sentences: ["Contact person@example.com.", "This leaks an address."], actionRequired: true,
		}), true)).toThrow("private or unsafe");
		expect(() => normalizeSummary(JSON.stringify({
			sentences: ["x".repeat(181), "Second sentence."], actionRequired: true,
		}), true)).toThrow("exceeds its bound");
		expect(() => normalizeSummary(JSON.stringify({
			sentences: ["First sentence.", "Second sentence."], actionRequired: false,
		}), true)).toThrow("action state is inconsistent");
		expect(summarySchedulerStatus().capacity).toBe(16);
	});

	test("binds identical client conversation IDs to separate server sessions", () => {
		expect(conversationBindingKey("session-a", "conversation_shared"))
			.not.toBe(conversationBindingKey("session-b", "conversation_shared"));
	});

	test("rejects unbounded messages and arbitrary context fields", () => {
		expect(parseChatInput({ conversationId: "conversation_test", message: "x".repeat(4_001) })).toEqual({
			error: "Message must contain 1-4000 characters",
		});
		expect(parseChatInput({ conversationId: "conversation_test", message: "Hello", context: { notificationId: "provider_message_id" } }))
			.toEqual({ error: "Invalid Inbox context" });
		expect(parseChatInput({ conversationId: "conversation_test", message: "Hello", model: "arbitrary-model" }))
			.toEqual({ error: "Invalid request body" });
		expect(parseChatInput({ conversationId: "../../thread", message: "Hello" }))
			.toEqual({ error: "Invalid conversation ID" });
		expect(parseChatInput({
			intent: "summarize_context",
			conversationId: "conversation_test",
			notificationId: "provider-message-id",
			context: { kind: "email", title: "Test", summary: "Test" },
		})).toEqual({ error: "Invalid notification ID" });
	});
});
