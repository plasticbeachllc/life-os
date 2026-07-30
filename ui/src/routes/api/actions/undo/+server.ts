import { json } from "@sveltejs/kit";

import {
	parseBrowserActionRequest,
	requireBrowserActionSubject,
} from "$lib/server/action-request";
import { consumeBrowserConfirmation } from "$lib/server/chat-session";
import { undoTaskAction } from "$lib/server/task-actions";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	try {
		const value = await parseBrowserActionRequest({
			request, url, keys: ["confirmationId", "actionUiId", "csrfToken"],
		});
		const sessionId = requireBrowserActionSubject({
			cookies,
			csrfToken: value.csrfToken!,
			subjectUiId: value.actionUiId!,
			subjectKind: "action",
		});
		const confirmation = consumeBrowserConfirmation({
			sessionId,
			confirmationId: value.confirmationId!,
			purpose: "undo_task_action",
		});
		if (!confirmation || confirmation.subjectUiId !== value.actionUiId) {
			throw new Error("undo confirmation mismatch");
		}
		return json({ receipt: await undoTaskAction(confirmation) });
	} catch {
		return json({ error: "Task creation was not undone; review the current receipt and try again" }, { status: 400 });
	}
};
