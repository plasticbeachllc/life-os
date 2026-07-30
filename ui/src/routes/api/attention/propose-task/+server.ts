import { json } from "@sveltejs/kit";

import {
	parseBrowserActionRequest,
	requireBrowserActionSubject,
} from "$lib/server/action-request";
import { proposeTaskFromAttention } from "$lib/server/task-actions";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	try {
		const value = await parseBrowserActionRequest({
			request, url, keys: ["attentionUiId", "csrfToken"],
		});
		requireBrowserActionSubject({
			cookies,
			csrfToken: value.csrfToken!,
			subjectUiId: value.attentionUiId!,
			subjectKind: "attention",
		});
		return json({ proposal: await proposeTaskFromAttention(value.attentionUiId!) }, { status: 201 });
	} catch {
		return json({ error: "Task proposal was rejected or could not be created" }, { status: 400 });
	}
};
