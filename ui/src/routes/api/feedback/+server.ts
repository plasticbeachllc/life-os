import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { json } from "@sveltejs/kit";
import { currentChatSession, validateFeedbackCapability } from "$lib/server/chat-session";
import { isSameOriginFeedbackRequest } from "$lib/server/feedback-security";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	if (!isSameOriginFeedbackRequest(request, url)) {
		return json({ error: "Feedback was rejected" }, { status: 403 });
	}
	let value: unknown;
	try { value = await request.json(); } catch { return json({ error: "Request body must be JSON" }, { status: 400 }); }
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid feedback");
		const record = value as Record<string, unknown>;
		if (Object.keys(record).some((key) => !["subjectKind", "subjectUiId", "outcome", "csrfToken"].includes(key))
			|| typeof record.csrfToken !== "string" || typeof record.subjectUiId !== "string"
			|| !["finding", "proposal"].includes(String(record.subjectKind))
			|| !validateFeedbackCapability({ sessionId: currentChatSession(cookies),
				token: record.csrfToken, subjectUiId: record.subjectUiId,
				subjectKind: record.subjectKind as "finding" | "proposal" })) {
			throw new Error("feedback capability mismatch");
		}
		const root = repositoryRoot();
		const [{ loadConfig }, { OperationalStore }, { recordUiFeedback }] = await Promise.all([
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/config.ts")).href),
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/db/store.ts")).href),
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/ui/feedback.ts")).href),
		]);
		const config = loadConfig(); const store = new OperationalStore(config.databasePath); store.migrate();
		recordUiFeedback({ store, value: {
			subjectKind: record.subjectKind, subjectUiId: record.subjectUiId, outcome: record.outcome,
		} });
		return json({ recorded: true }, { status: 201 });
	} catch {
		return json({ error: "Feedback was rejected" }, { status: 400 });
	}
};

function repositoryRoot(): string {
	const configured = process.env.LIFE_OS_REPO_PATH;
	if (configured) return resolve(configured);
	const cwd = process.cwd();
	if (existsSync(resolve(cwd, "src/db/schema.ts"))) return cwd;
	if (existsSync(resolve(cwd, "../src/db/schema.ts"))) return resolve(cwd, "..");
	throw new Error("LifeOS repository root was not found");
}
