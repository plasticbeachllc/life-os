import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { UiNotificationBundle, UiNotificationSummaryCandidate } from "../../../../src/ui/notifications";
import { CodexAppServerClient } from "$lib/server/codex/app-server";

export interface NotificationAgentSummary {
	sentences: string[];
	actionRequired: boolean;
}

let queue: Promise<void> = Promise.resolve();
const inFlight = new Map<string, Promise<NotificationAgentSummary>>();
let summaryClient: CodexAppServerClient | undefined;

export function prewarmNotificationSummaries(candidates: UiNotificationSummaryCandidate[]): void {
	for (const candidate of candidates) {
		if (!candidate.cachedSummary) void schedule(candidate).catch(() => undefined);
	}
}

export async function getNotificationSummary(notificationId: string): Promise<NotificationAgentSummary> {
	const { notificationModule } = await rootModules();
	const candidate = notificationModule.compileUiNotificationBundle().summaryCandidates
		.find((item) => item.notificationId === notificationId);
	if (!candidate) throw new Error("Notification summary candidate is no longer current");
	if (candidate.cachedSummary) return candidate.cachedSummary;
	return schedule(candidate);
}

function schedule(candidate: UiNotificationSummaryCandidate): Promise<NotificationAgentSummary> {
	const existing = inFlight.get(candidate.cacheKey);
	if (existing) return existing;
	let resolveTask!: (summary: NotificationAgentSummary) => void;
	let rejectTask!: (error: unknown) => void;
	const task = new Promise<NotificationAgentSummary>((resolve, reject) => {
		resolveTask = resolve;
		rejectTask = reject;
	});
	inFlight.set(candidate.cacheKey, task);
	queue = queue.catch(() => undefined).then(async () => {
		try {
			resolveTask(await generate(candidate));
		} catch (error) {
			rejectTask(error);
		} finally {
			inFlight.delete(candidate.cacheKey);
		}
	});
	return task;
}

async function generate(candidate: UiNotificationSummaryCandidate): Promise<NotificationAgentSummary> {
	const { configModule, storeModule, notificationModule, idsModule } = await rootModules();
	const config = configModule.loadConfig();
	const store = new storeModule.OperationalStore(config.databasePath);
	store.migrate();
	const cached = parseSummary(store.getModelCache(candidate.cacheKey)?.output);
	if (cached) return cached;

	const callId = idsModule.newId("call");
	const startedAt = new Date().toISOString();
	store.recordModelCall({
		callId,
		workflow: "ui-notification-summary",
		taskType: "bounded_summary",
		model: candidate.model,
		promptVersion: candidate.promptVersion,
		sourceHash: candidate.sourceHash,
		contextHash: candidate.manifest.contextHash,
		cached: false,
		startedAt,
		status: "started",
	});
	store.recordContextManifest({
		manifestId: candidate.manifest.manifestId,
		callId,
		includedItems: candidate.manifest.includedItems,
		omittedItems: candidate.manifest.omittedItems,
		tokenBudget: candidate.manifest.tokenBudget,
		retrievalLevels: candidate.manifest.retrievalLevels,
		rankingVersion: candidate.manifest.rankingVersion,
		contextHash: candidate.manifest.contextHash,
		createdAt: candidate.manifest.createdAt,
	});

	try {
		const groundedContext = candidate.manifest.includedItems.map((item) => item.content);
		summaryClient ??= new CodexAppServerClient();
		const text = await summaryClient.streamTurn({
			conversationId: `conversation_summary_${candidate.cacheKey.slice(-24)}`,
			model: candidate.model,
			message: `Write a concise user-facing reaction to this LifeOS notification using only the grounded context below. Do not call tools. Explain what happened, why it matters, and whether the user needs to act. Write exactly 2 or 3 short sentences, putting each sentence on its own line. Use no bullets, headings, identifiers, hashes, addresses, or source excerpts.\n\nGrounded context:\n${JSON.stringify(groundedContext)}`,
			onDelta: () => undefined,
		});
		const summary = normalizeSummary(text, candidate.actionRequired);
		const current = notificationModule.compileUiNotificationBundle().summaryCandidates
			.find((item) => item.notificationId === candidate.notificationId);
		if (!current || current.cacheKey !== candidate.cacheKey
			|| current.sourceHash !== candidate.sourceHash
			|| current.manifest.contextHash !== candidate.manifest.contextHash) {
			throw new Error("Notification changed while its summary was being generated");
		}
		store.putModelCache({
			cacheKey: candidate.cacheKey,
			workflow: "ui-notification-summary",
			promptVersion: candidate.promptVersion,
			model: candidate.model,
			sourceHash: candidate.sourceHash,
			contextHash: candidate.manifest.contextHash,
			schemaVersion: candidate.schemaVersion,
			policyVersion: candidate.policyVersion,
			output: summary,
			createdAt: new Date().toISOString(),
		});
		store.recordModelCall({
			callId,
			workflow: "ui-notification-summary",
			taskType: "bounded_summary",
			model: candidate.model,
			promptVersion: candidate.promptVersion,
			sourceHash: candidate.sourceHash,
			contextHash: candidate.manifest.contextHash,
			cached: false,
			startedAt,
			completedAt: new Date().toISOString(),
			status: "completed",
		});
		return summary;
	} catch (error) {
		store.recordModelCall({
			callId,
			workflow: "ui-notification-summary",
			taskType: "bounded_summary",
			model: candidate.model,
			promptVersion: candidate.promptVersion,
			sourceHash: candidate.sourceHash,
			contextHash: candidate.manifest.contextHash,
			cached: false,
			startedAt,
			completedAt: new Date().toISOString(),
			status: "failed",
			error: error instanceof Error ? error.message : "Notification summary failed",
		});
		throw error;
	}
}

export function normalizeSummary(text: string, actionRequired: boolean): NotificationAgentSummary {
	const sentences = text
		.split(/\n+/)
		.flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z“"'])/))
		.map((sentence) => sentence.trim().replace(/^[-*]\s+/, ""))
		.filter(Boolean)
		.slice(0, 3);
	if (sentences.length === 0) throw new Error("Notification summary was empty");
	return { sentences, actionRequired };
}

function parseSummary(value: unknown): NotificationAgentSummary | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.sentences) || typeof record.actionRequired !== "boolean") return undefined;
	const sentences = record.sentences.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return sentences.length > 0 ? { sentences: sentences.slice(0, 3), actionRequired: record.actionRequired } : undefined;
}

interface RootModules {
	configModule: { loadConfig: () => { databasePath: string } };
	storeModule: { OperationalStore: new (databasePath: string) => any };
	notificationModule: { compileUiNotificationBundle: () => UiNotificationBundle };
	idsModule: { newId: (prefix: string) => string };
}

let rootModulesPromise: Promise<RootModules> | undefined;

function rootModules(): Promise<RootModules> {
	rootModulesPromise ??= loadRootModules();
	return rootModulesPromise;
}

async function loadRootModules(): Promise<RootModules> {
	const root = repositoryRoot();
	const [configModule, storeModule, notificationModule, idsModule] = await Promise.all([
		import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/config.ts")).href),
		import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/db/store.ts")).href),
		import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/ui/notifications.ts")).href),
		import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/util/ids.ts")).href),
	]);
	return { configModule, storeModule, notificationModule, idsModule } as RootModules;
}

function repositoryRoot(): string {
	const configured = process.env.LIFE_OS_REPO_PATH;
	if (configured) return resolve(configured);
	const cwd = process.cwd();
	if (existsSync(resolve(cwd, "src/db/schema.ts"))) return cwd;
	if (existsSync(resolve(cwd, "../src/db/schema.ts"))) return resolve(cwd, "..");
	throw new Error("LifeOS repository root was not found; set LIFE_OS_REPO_PATH");
}
