import { json } from "@sveltejs/kit";

import {
	parseBrowserActionRequest,
	requireBrowserActionSubject,
} from "$lib/server/action-request";
import { consumeBrowserConfirmation } from "$lib/server/chat-session";
import { applyTaskProposal } from "$lib/server/task-actions";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	try {
		const value = await parseBrowserActionRequest({
			request, url, keys: ["confirmationId", "proposalUiId", "csrfToken"],
		});
		const sessionId = requireBrowserActionSubject({
			cookies,
			csrfToken: value.csrfToken!,
			subjectUiId: value.proposalUiId!,
			subjectKind: "proposal",
		});
		const confirmation = consumeBrowserConfirmation({
			sessionId,
			confirmationId: value.confirmationId!,
			purpose: "apply_task_proposal",
		});
		if (!confirmation || confirmation.subjectUiId !== value.proposalUiId) {
			throw new Error("task confirmation mismatch");
		}
		return json({ receipt: await applyTaskProposal(confirmation) });
	} catch {
		return json({ error: "Task was not added; review the current proposal and try again" }, { status: 400 });
	}
};
