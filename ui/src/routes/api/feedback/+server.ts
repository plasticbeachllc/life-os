import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
	let value: unknown;
	try { value = await request.json(); } catch { return json({ error: "Request body must be JSON" }, { status: 400 }); }
	try {
		const root = repositoryRoot();
		const [{ loadConfig }, { OperationalStore }, { recordUiFeedback }] = await Promise.all([
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/config.ts")).href),
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/db/store.ts")).href),
			import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/ui/feedback.ts")).href),
		]);
		const config = loadConfig(); const store = new OperationalStore(config.databasePath); store.migrate();
		recordUiFeedback({ store, value });
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
