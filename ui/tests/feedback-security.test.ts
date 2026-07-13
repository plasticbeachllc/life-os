import { expect, test } from "bun:test";

import { isSameOriginFeedbackRequest } from "../src/lib/server/feedback-security";

test("feedback requires JSON from the exact browser origin", () => {
	const url = new URL("https://life-os.local/api/feedback");
	const request = (headers: Record<string, string>) => new Request(url, {
		method: "POST", headers, body: "{}",
	});
	expect(isSameOriginFeedbackRequest(request({
		origin: "https://life-os.local", "sec-fetch-site": "same-origin",
		"content-type": "application/json",
	}), url)).toBe(true);
	const rejected: Array<Record<string, string>> = [
		{ origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" },
		{ origin: "https://life-os.local", "sec-fetch-site": "cross-site", "content-type": "application/json" },
		{ origin: "https://life-os.local", "sec-fetch-site": "same-origin", "content-type": "text/plain" },
		{ "sec-fetch-site": "same-origin", "content-type": "application/json" },
	];
	for (const headers of rejected) expect(isSameOriginFeedbackRequest(request(headers), url)).toBe(false);
});
