import { describe, expect, test } from "bun:test";

import { parseChatInput } from "../src/lib/server/chat-input";

describe("LifeOS chat API input", () => {
	test("accepts a bounded message and sanitized Inbox context", () => {
		expect(parseChatInput({
			message: "  What needs my attention?  ",
			context: { title: "Email needs clarification", summary: "Ownership is unclear." },
		})).toEqual({
			message: "What needs my attention?",
			context: { title: "Email needs clarification", summary: "Ownership is unclear." },
		});
	});

	test("rejects unbounded messages and arbitrary context fields", () => {
		expect(parseChatInput({ message: "x".repeat(4_001) })).toEqual({
			error: "Message must contain 1-4000 characters",
		});
		expect(parseChatInput({ message: "Hello", context: { notificationId: "provider_message_id" } }))
			.toEqual({ error: "Invalid Inbox context" });
	});
});
