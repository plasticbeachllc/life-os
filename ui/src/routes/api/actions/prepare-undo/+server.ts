import { json } from "@sveltejs/kit";

import {
	parseBrowserActionRequest,
	requireBrowserActionSubject,
} from "$lib/server/action-request";
import { issueBrowserConfirmation } from "$lib/server/chat-session";
import { prepareTaskUndo } from "$lib/server/task-actions";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	try {
		const value = await parseBrowserActionRequest({
			request, url, keys: ["actionUiId", "csrfToken"],
		});
		const sessionId = requireBrowserActionSubject({
			cookies,
			csrfToken: value.csrfToken!,
			subjectUiId: value.actionUiId!,
			subjectKind: "action",
		});
		const prepared = await prepareTaskUndo(value.actionUiId!);
		const confirmation = issueBrowserConfirmation({
			sessionId,
			confirmation: {
				purpose: "undo_task_action",
				subjectUiId: prepared.subjectUiId,
				authorizationToken: prepared.authorizationToken,
				actionId: prepared.actionId,
				expiresAt: prepared.expiresAt,
			},
		});
		return json({
			confirmationId: confirmation.confirmationId,
			expiresAt: confirmation.expiresAt,
			title: "Undo task creation?",
			preview: prepared.preview,
			confirmLabel: "Undo",
		});
	} catch {
		return json({ error: "Undo is stale or could not be prepared" }, { status: 400 });
	}
};
