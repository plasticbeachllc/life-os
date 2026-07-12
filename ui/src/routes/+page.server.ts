import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { UiNotificationBundle } from "../../../src/ui/notifications";
import { prewarmNotificationSummaries } from "$lib/server/notification-summaries";
import type { PageServerLoad } from "./$types";

interface NotificationModule {
	compileUiNotificationBundle: () => UiNotificationBundle;
}

export const load: PageServerLoad = async () => {
	const root = repositoryRoot();
	const moduleUrl = pathToFileURL(resolve(root, "src/ui/notifications.ts")).href;
	const notificationModule = await import(/* @vite-ignore */ moduleUrl) as NotificationModule;
	const bundle = notificationModule.compileUiNotificationBundle();
	prewarmNotificationSummaries(bundle.summaryCandidates);
	return bundle.snapshot;
};

function repositoryRoot(): string {
	const configured = process.env.LIFE_OS_REPO_PATH;
	if (configured) return resolve(configured);
	const cwd = process.cwd();
	if (existsSync(resolve(cwd, "src/db/schema.ts"))) return cwd;
	if (existsSync(resolve(cwd, "../src/db/schema.ts"))) return resolve(cwd, "..");
	throw new Error("LifeOS repository root was not found; set LIFE_OS_REPO_PATH");
}
