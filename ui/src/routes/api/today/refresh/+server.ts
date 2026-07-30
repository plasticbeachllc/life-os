import { json } from "@sveltejs/kit";
import {
	cancelProcessingJob,
	processingJobStatus,
	startProcessingJob,
} from "$lib/server/processing-jobs";
import { currentChatSession, validateWorkspaceRefreshCapability } from "$lib/server/chat-session";
import { isSameOriginFeedbackRequest } from "$lib/server/feedback-security";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	try {
		return json({ run: await processingJobStatus() });
	} catch {
		return json({ error: "Processing status is unavailable" }, { status: 503 });
	}
};

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	if (!isSameOriginFeedbackRequest(request, url)) {
		return json({ error: "Processing was rejected" }, { status: 403 });
	}
	try {
		await requireCapability(request, currentChatSession(cookies));
		return json({ run: await startProcessingJob() }, { status: 202 });
	} catch {
		return json({ error: "Processing was rejected or could not start" }, { status: 400 });
	}
};

export const DELETE: RequestHandler = async ({ request, cookies, url }) => {
	if (!isSameOriginFeedbackRequest(request, url)) {
		return json({ error: "Cancellation was rejected" }, { status: 403 });
	}
	try {
		await requireCapability(request, currentChatSession(cookies));
		return json({ run: await cancelProcessingJob() });
	} catch {
		return json({ error: "Cancellation was rejected" }, { status: 400 });
	}
};

async function requireCapability(request: Request, sessionId: string | undefined): Promise<void> {
	const value: unknown = await request.json();
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid processing request");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => key !== "csrfToken") || typeof record.csrfToken !== "string"
		|| !validateWorkspaceRefreshCapability({ sessionId, token: record.csrfToken })) {
		throw new Error("processing capability mismatch");
	}
}
