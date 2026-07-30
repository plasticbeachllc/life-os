import { json } from "@sveltejs/kit";

import {
	parseBrowserActionRequest,
	requireBrowserActionSubject,
} from "$lib/server/action-request";
import { issueBrowserConfirmation } from "$lib/server/chat-session";
import { prepareTaskProposal } from "$lib/server/task-actions";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	try {
		const value = await parseBrowserActionRequest({
			request, url, keys: ["proposalUiId", "csrfToken"],
		});
		const sessionId = requireBrowserActionSubject({
			cookies,
			csrfToken: value.csrfToken!,
			subjectUiId: value.proposalUiId!,
			subjectKind: "proposal",
		});
		const prepared = await prepareTaskProposal(value.proposalUiId!);
		const confirmation = issueBrowserConfirmation({
			sessionId,
			confirmation: {
				purpose: "apply_task_proposal",
				subjectUiId: prepared.subjectUiId,
				authorizationToken: prepared.authorizationToken,
				proposalId: prepared.proposalId,
				actionId: prepared.actionId,
				expiresAt: prepared.expiresAt,
			},
		});
		return json({
			confirmationId: confirmation.confirmationId,
			expiresAt: confirmation.expiresAt,
			title: "Add this task to your Inbox?",
			preview: prepared.preview,
			confirmLabel: "Add task",
		});
	} catch {
		return json({ error: "Task proposal is stale or could not be prepared" }, { status: 400 });
	}
};
