import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { json } from "@sveltejs/kit";
import { currentChatSession, validateWorkspaceRefreshCapability } from "$lib/server/chat-session";
import { isSameOriginFeedbackRequest } from "$lib/server/feedback-security";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	if (!isSameOriginFeedbackRequest(request, url)) return json({ error: "Refresh was rejected" }, { status: 403 });
	try {
		const value: unknown = await request.json();
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid refresh");
		const record = value as Record<string, unknown>;
		if (Object.keys(record).some((key) => key !== "csrfToken") || typeof record.csrfToken !== "string"
			|| !validateWorkspaceRefreshCapability({ sessionId: currentChatSession(cookies), token: record.csrfToken })) {
			throw new Error("refresh capability mismatch");
		}
		const root = repositoryRoot();
		const [{ loadConfig }, { OperationalStore }, { ObsidianVault }, { refreshToday }] = await Promise.all([
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/config.ts")).href),
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/db/store.ts")).href),
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/adapters/obsidian.ts")).href),
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/workflows/refresh-today.ts")).href),
		]);
		const config = loadConfig();
		const report = await refreshToday({ vault: new ObsidianVault(config.vaultPath),
			store: new OperationalStore(config.databasePath), vaultPath: config.vaultPath });
		return json({ refreshed: true, providers: report.providers.map((provider: { provider: string; status: string }) => ({
			provider: provider.provider, status: provider.status,
		})), modelCalls: 0 });
	} catch {
		return json({ error: "Refresh was rejected or could not complete" }, { status: 400 });
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
