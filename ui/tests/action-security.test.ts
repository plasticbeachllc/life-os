import { expect, test } from "bun:test";

import { parseBrowserActionRequest } from "../src/lib/server/action-request";

test("browser action requests require exact same-origin JSON shapes", async () => {
	const url = new URL("http://127.0.0.1:5173/api/proposals/prepare");
	const request = (body: unknown, headers: Record<string, string> = {}) => new Request(url, {
		method: "POST",
		headers: {
			origin: url.origin,
			"sec-fetch-site": "same-origin",
			"content-type": "application/json",
			...headers,
		},
		body: JSON.stringify(body),
	});
	await expect(parseBrowserActionRequest({
		request: request({ proposalUiId: "ui_0123456789abcdefabcd", csrfToken: "a".repeat(64) }),
		url,
		keys: ["proposalUiId", "csrfToken"],
	})).resolves.toEqual({
		proposalUiId: "ui_0123456789abcdefabcd",
		csrfToken: "a".repeat(64),
	});
	for (const rejected of [
		request({ proposalUiId: "ui_0123456789abcdefabcd", csrfToken: "a".repeat(64), actionId: "act_private" }),
		request({ proposalUiId: "ui_0123456789abcdefabcd" }),
		request({ proposalUiId: 42, csrfToken: "a".repeat(64) }),
		request({ proposalUiId: "ui_0123456789abcdefabcd", csrfToken: "a".repeat(64) }, { origin: "https://evil.example" }),
		request({ proposalUiId: "ui_0123456789abcdefabcd", csrfToken: "a".repeat(64) }, { "content-type": "text/plain" }),
	]) {
		await expect(parseBrowserActionRequest({
			request: rejected,
			url,
			keys: ["proposalUiId", "csrfToken"],
		})).rejects.toThrow();
	}
});
