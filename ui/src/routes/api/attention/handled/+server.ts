import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { json } from "@sveltejs/kit";
import { currentChatSession, validateFeedbackCapability } from "$lib/server/chat-session";
import { isSameOriginFeedbackRequest } from "$lib/server/feedback-security";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	if (!isSameOriginFeedbackRequest(request, url)) return json({ error: "Action was rejected" }, { status: 403 });
	let value: unknown;
	try { value = await request.json(); } catch { return json({ error: "Request body must be JSON" }, { status: 400 }); }
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid action");
		const record = value as Record<string, unknown>;
		if (Object.keys(record).some((key) => !["subjectUiId", "csrfToken"].includes(key))
			|| typeof record.subjectUiId !== "string" || typeof record.csrfToken !== "string"
			|| !validateFeedbackCapability({ sessionId: currentChatSession(cookies), token: record.csrfToken,
				subjectUiId: record.subjectUiId, subjectKind: "attention" })) throw new Error("capability mismatch");
		const root = repositoryRoot();
		const [{ loadConfig }, { OperationalStore }, { markAttentionHandledFromUi }] = await Promise.all([
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/config.ts")).href),
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/db/store.ts")).href),
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/ui/attention-lifecycle.ts")).href),
		]);
		const config = loadConfig(); const store = new OperationalStore(config.databasePath); store.migrate();
		markAttentionHandledFromUi({ store, subjectUiId: record.subjectUiId });
		return json({ handled: true }, { status: 201 });
	} catch { return json({ error: "Action was rejected" }, { status: 400 }); }
};

function repositoryRoot(): string {
	const configured = process.env.LIFE_OS_REPO_PATH;
	if (configured) return resolve(configured);
	const cwd = process.cwd();
	if (existsSync(resolve(cwd, "src/db/schema.ts"))) return cwd;
	if (existsSync(resolve(cwd, "../src/db/schema.ts"))) return resolve(cwd, "..");
	throw new Error("LifeOS repository root was not found");
}
