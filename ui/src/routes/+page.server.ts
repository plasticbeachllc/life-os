import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { UiNotificationBundle } from "../../../src/ui/notifications";
import type { UiWorkspaceSnapshot } from "../../../src/ui/workspace";
import { ensureChatSession } from "$lib/server/chat-session";
import { prewarmNotificationSummaries } from "$lib/server/notification-summaries";
import type { PageServerLoad } from "./$types";

interface NotificationModule {
	compileUiNotificationBundle: () => UiNotificationBundle;
}

interface WorkspaceModule { compileUiWorkspace: () => Promise<UiWorkspaceSnapshot> }

export const load: PageServerLoad = async ({ cookies }) => {
	ensureChatSession(cookies);
	const root = repositoryRoot();
	const moduleUrl = pathToFileURL(resolve(root, "src/ui/notifications.ts")).href;
	const notificationModule = await import(/* @vite-ignore */ moduleUrl) as NotificationModule;
	const bundle = notificationModule.compileUiNotificationBundle();
	prewarmNotificationSummaries(bundle.summaryCandidates);
	const workspaceUrl = pathToFileURL(resolve(root, "src/ui/workspace.ts")).href;
	const workspaceModule = await import(/* @vite-ignore */ workspaceUrl) as WorkspaceModule;
	return { ...bundle.snapshot, workspace: await workspaceModule.compileUiWorkspace() };
};

function repositoryRoot(): string {
	const configured = process.env.LIFE_OS_REPO_PATH;
	if (configured) return resolve(configured);
	const cwd = process.cwd();
	if (existsSync(resolve(cwd, "src/db/schema.ts"))) return cwd;
	if (existsSync(resolve(cwd, "../src/db/schema.ts"))) return resolve(cwd, "..");
	throw new Error("LifeOS repository root was not found; set LIFE_OS_REPO_PATH");
}
