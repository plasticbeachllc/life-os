import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
	SyncProcessState,
	SyncProcessView,
} from "../../../../src/workflows/sync-process";

const activeJobs = new Map<string, Promise<void>>();

export async function startProcessingJob(): Promise<SyncProcessView> {
	const modules = await loadModules();
	const config = modules.config.loadConfig();
	const store = new modules.store.OperationalStore(config.databasePath);
	store.migrate();
	const repository = new modules.workflow.SyncProcessRepository(store);
	const result = repository.create({
		gmail: config.gmailEnabled ? 5 : 0,
		imessage: config.imessageEnabled ? 5 : 0,
		model: "gpt-5.6-sol",
	});
	launch(result.state, { modules, config, store });
	return requireView(modules.workflow.syncProcessView(result.state));
}

export async function processingJobStatus(): Promise<SyncProcessView | undefined> {
	const modules = await loadModules();
	const config = modules.config.loadConfig();
	const store = new modules.store.OperationalStore(config.databasePath);
	store.migrate();
	const repository = new modules.workflow.SyncProcessRepository(store);
	let state = repository.get();
	if (state?.status === "queued") launch(state, { modules, config, store });
	else if (state && !activeJobs.has(state.runId)
		&& ["running", "cancellation_requested"].includes(state.status)) {
		state = state.status === "cancellation_requested"
			? repository.finish(state.runId, "cancelled")
			: repository.interrupt(state.runId);
	}
	return modules.workflow.syncProcessView(state);
}

export async function cancelProcessingJob(): Promise<SyncProcessView | undefined> {
	const modules = await loadModules();
	const config = modules.config.loadConfig();
	const store = new modules.store.OperationalStore(config.databasePath);
	store.migrate();
	const state = new modules.workflow.SyncProcessRepository(store).requestCancel();
	return modules.workflow.syncProcessView(state);
}

function launch(state: SyncProcessState, input: {
	modules: LoadedModules;
	config: ReturnType<LoadedModules["config"]["loadConfig"]>;
	store: InstanceType<LoadedModules["store"]["OperationalStore"]>;
}): void {
	if (state.status !== "queued" || activeJobs.has(state.runId)) return;
	const job = input.modules.workflow.executeSyncProcess({
		store: input.store,
		vault: new input.modules.obsidian.ObsidianVault(input.config.vaultPath),
		vaultPath: input.config.vaultPath,
		runId: state.runId,
	}).then(() => undefined)
		.catch(() => undefined)
		.finally(() => activeJobs.delete(state.runId));
	activeJobs.set(state.runId, job);
}

function requireView(view: SyncProcessView | undefined): SyncProcessView {
	if (!view) throw new Error("processing job state is unavailable");
	return view;
}

interface LoadedModules {
	config: typeof import("../../../../src/config");
	store: typeof import("../../../../src/db/store");
	obsidian: typeof import("../../../../src/adapters/obsidian");
	workflow: typeof import("../../../../src/workflows/sync-process");
}

async function loadModules(): Promise<LoadedModules> {
	const root = repositoryRoot();
	const [config, store, obsidian, workflow] = await Promise.all([
		import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/config.ts")).href) as Promise<LoadedModules["config"]>,
		import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/db/store.ts")).href) as Promise<LoadedModules["store"]>,
		import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/adapters/obsidian.ts")).href) as Promise<LoadedModules["obsidian"]>,
		import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/workflows/sync-process.ts")).href) as Promise<LoadedModules["workflow"]>,
	]);
	return { config, store, obsidian, workflow };
}

function repositoryRoot(): string {
	const configured = process.env.LIFE_OS_REPO_PATH;
	if (configured) return resolve(configured);
	const cwd = process.cwd();
	if (existsSync(resolve(cwd, "src/db/schema.ts"))) return cwd;
	if (existsSync(resolve(cwd, "../src/db/schema.ts"))) return resolve(cwd, "..");
	throw new Error("LifeOS repository root was not found");
}
