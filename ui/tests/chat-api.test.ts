import { describe, expect, test } from "bun:test";

import { parseChatInput } from "../src/lib/server/chat-input";
import { conversationBindingKey } from "../src/lib/server/codex/app-server";
import { buildNotificationOpeningPrompt, normalizeSummary, summarySchedulerStatus } from "../src/lib/server/notification-summaries";

describe("LifeOS chat API input", () => {
	test("accepts a bounded message and untrusted Inbox context", () => {
		expect(parseChatInput({
			conversationId: "conversation_email_1",
			message: "  What needs my attention?  ",
			context: { kind: "email", category: "needs_you", title: "Email needs clarification",
				summary: "Ownership is unclear.", suggestedAction: "Clarify" },
		})).toEqual({
			intent: "chat",
			conversationId: "conversation_email_1",
			message: "What needs my attention?",
			context: { kind: "email", category: "needs_you", title: "Email needs clarification",
				summary: "Ownership is unclear.", suggestedAction: "Clarify" },
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
		const openingPrompt = buildNotificationOpeningPrompt({
			groundedContext: [{ title: "A commitment may be resolved" }], actionRequired: true,
		});
		expect(openingPrompt).toContain("bottom line");
		expect(openingPrompt).toContain("one concrete, proportionate next move");
		expect(openingPrompt).toContain("materially change the recommended next step");
		expect(openingPrompt).toContain("do not merely repeat");
		expect(openingPrompt).toContain("Do not speculate about consequences");
		expect(openingPrompt).toContain("Do not ask a question that is answered by carrying out");
		expect(openingPrompt).toContain("must not repeat the question as an imperative");
		expect(normalizeSummary(JSON.stringify({
			assessment: "The refund is likely in progress.",
			recommendedNextStep: "Check whether the credit reached the original payment method.",
			question: null, actionRequired: true,
		}), true)).toEqual({
			sentences: ["The refund is likely in progress.", "Check whether the credit reached the original payment method."],
			actionRequired: true,
		});
		expect(() => normalizeSummary(JSON.stringify({
			assessment: "Only one sentence.", recommendedNextStep: "", question: null, actionRequired: true,
		}), true)).toThrow("exceeds its bound");
		expect(() => normalizeSummary(JSON.stringify({
			assessment: "Contact person@example.com.", recommendedNextStep: "This leaks an address.",
			question: null, actionRequired: true,
		}), true)).toThrow("private or unsafe");
		expect(() => normalizeSummary(JSON.stringify({
			assessment: "x".repeat(181), recommendedNextStep: "Second sentence.", question: null, actionRequired: true,
		}), true)).toThrow("exceeds its bound");
		expect(() => normalizeSummary(JSON.stringify({
			assessment: "First sentence.", recommendedNextStep: "Second sentence.", question: null, actionRequired: false,
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
		expect(parseChatInput({ conversationId: "conversation_test", message: "Hello",
			context: { kind: "task", category: "private", title: "Test", summary: "Test" } }))
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
