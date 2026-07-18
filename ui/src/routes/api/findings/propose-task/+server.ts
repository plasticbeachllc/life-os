import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { json } from "@sveltejs/kit";
import { currentChatSession, validateFeedbackCapability } from "$lib/server/chat-session";
import { isSameOriginFeedbackRequest } from "$lib/server/feedback-security";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	if (!isSameOriginFeedbackRequest(request, url)) return json({ error: "Proposal was rejected" }, { status: 403 });
	try {
		const value: unknown = await request.json();
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid proposal");
		const record = value as Record<string, unknown>;
		if (Object.keys(record).some((key) => !["findingUiId", "csrfToken"].includes(key))
			|| typeof record.findingUiId !== "string" || typeof record.csrfToken !== "string"
			|| !validateFeedbackCapability({ sessionId: currentChatSession(cookies), token: record.csrfToken,
				subjectUiId: record.findingUiId, subjectKind: "finding" })) throw new Error("proposal capability mismatch");
		const root = repositoryRoot();
		const [{ loadConfig }, { OperationalStore }, { ObsidianVault }, { proposeFindingTaskFromUi }] = await Promise.all([
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/config.ts")).href),
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/db/store.ts")).href),
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/adapters/obsidian.ts")).href),
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/ui/finding-task.ts")).href),
		]);
		const config = loadConfig();
		const proposal = await proposeFindingTaskFromUi({ findingUiId: record.findingUiId,
			vault: new ObsidianVault(config.vaultPath), store: new OperationalStore(config.databasePath) });
		return json({ created: true, proposal: { effectType: proposal.effectType, approval: proposal.approval, preview: proposal.preview } }, { status: 201 });
	} catch { return json({ error: "Proposal was rejected or could not be created" }, { status: 400 }); }
};

function repositoryRoot(): string {
	const configured = process.env.LIFE_OS_REPO_PATH;
	if (configured) return resolve(configured);
	const cwd = process.cwd();
	if (existsSync(resolve(cwd, "src/db/schema.ts"))) return cwd;
	if (existsSync(resolve(cwd, "../src/db/schema.ts"))) return resolve(cwd, "..");
	throw new Error("LifeOS repository root was not found");
}
