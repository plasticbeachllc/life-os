import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { UiNotificationBundle, UiNotificationSummaryCandidate } from "../../../../src/ui/notifications";
import { CodexAppServerClient } from "./codex/app-server";

export interface NotificationAgentSummary {
	sentences: string[];
	actionRequired: boolean;
}

type JobPriority = "selected" | "prewarm";
interface SummaryJob {
	candidate: UiNotificationSummaryCandidate;
	priority: JobPriority;
	promise: Promise<NotificationAgentSummary>;
	resolve: (summary: NotificationAgentSummary) => void;
	reject: (error: unknown) => void;
}

const maxQueuedJobs = 16;
const maxRetryEntries = 100;
const retryBaseMs = 5_000;
const retryMaxMs = 5 * 60_000;
const pendingJobs: SummaryJob[] = [];
const scheduledJobs = new Map<string, SummaryJob>();
const retryState = new Map<string, { attempts: number; nextRetryAt: number; failedAt: number }>();
const summarySessionId = randomUUID();
let workerRunning = false;
let summaryClient: CodexAppServerClient | undefined;

export function prewarmNotificationSummaries(candidates: UiNotificationSummaryCandidate[]): void {
	const prioritized = [...candidates].sort((left, right) => Number(right.actionRequired) - Number(left.actionRequired));
	for (const candidate of prioritized) {
		if (!candidate.cachedSummary) void schedule(candidate, "prewarm").catch(() => undefined);
	}
}

export async function getNotificationSummary(notificationId: string): Promise<NotificationAgentSummary> {
	const { notificationModule } = await rootModules();
	const candidate = notificationModule.compileUiNotificationBundle().summaryCandidates
		.find((item) => item.notificationId === notificationId);
	if (!candidate) throw new Error("Notification summary candidate is no longer current");
	if (candidate.cachedSummary) return validateSummary(candidate.cachedSummary, candidate.actionRequired);
	return schedule(candidate, "selected");
}

function schedule(candidate: UiNotificationSummaryCandidate, priority: JobPriority): Promise<NotificationAgentSummary> {
	pruneRetryState();
	const existing = scheduledJobs.get(candidate.cacheKey);
	if (existing) {
		if (priority === "selected" && existing.priority === "prewarm") {
			existing.priority = "selected";
			pendingJobs.sort(jobPriority);
		}
		return existing.promise;
	}
	const retry = retryState.get(candidate.cacheKey);
	if (retry && retry.nextRetryAt > Date.now()) {
		return Promise.reject(new Error("Notification summary retry is temporarily backed off"));
	}
	if (pendingJobs.length >= maxQueuedJobs) {
		if (priority !== "selected") {
			return Promise.reject(new Error("Notification summary prewarm queue capacity reached"));
		}
		const replaceIndex = pendingJobs.findLastIndex((job) => job.priority === "prewarm");
		if (replaceIndex < 0) return Promise.reject(new Error("Notification summary queue capacity reached"));
		const [removed] = pendingJobs.splice(replaceIndex, 1);
		if (removed) {
			scheduledJobs.delete(removed.candidate.cacheKey);
			removed.reject(new Error("Notification summary prewarm was displaced by a selected item"));
		}
	}

	let resolveTask!: (summary: NotificationAgentSummary) => void;
	let rejectTask!: (error: unknown) => void;
	const task = new Promise<NotificationAgentSummary>((resolve, reject) => {
		resolveTask = resolve;
		rejectTask = reject;
	});
	const job: SummaryJob = { candidate, priority, promise: task, resolve: resolveTask, reject: rejectTask };
	scheduledJobs.set(candidate.cacheKey, job);
	pendingJobs.push(job);
	pendingJobs.sort(jobPriority);
	void pumpQueue();
	return task;
}

async function pumpQueue(): Promise<void> {
	if (workerRunning) return;
	workerRunning = true;
	try {
		while (pendingJobs.length > 0) {
			const job = pendingJobs.shift()!;
			try {
				const summary = await generate(job.candidate);
				retryState.delete(job.candidate.cacheKey);
				job.resolve(summary);
			} catch (error) {
				const prior = retryState.get(job.candidate.cacheKey);
				const attempts = (prior?.attempts ?? 0) + 1;
				const failedAt = Date.now();
				retryState.set(job.candidate.cacheKey, {
					attempts,
					failedAt,
					nextRetryAt: failedAt + Math.min(retryMaxMs, retryBaseMs * 2 ** (attempts - 1)),
				});
				pruneRetryState();
				job.reject(error);
			} finally {
				scheduledJobs.delete(job.candidate.cacheKey);
			}
		}
	} finally {
		workerRunning = false;
	}
}

function jobPriority(left: SummaryJob, right: SummaryJob): number {
	return Number(right.priority === "selected") - Number(left.priority === "selected");
}

function pruneRetryState(): void {
	const now = Date.now();
	for (const [key, value] of retryState) {
		if (now - value.failedAt > retryMaxMs * 2) retryState.delete(key);
	}
	while (retryState.size > maxRetryEntries) {
		const oldest = [...retryState.entries()].sort((left, right) => left[1].failedAt - right[1].failedAt)[0];
		if (!oldest) break;
		retryState.delete(oldest[0]);
	}
}

export function summarySchedulerStatus(): { queued: number; scheduled: number; retries: number; capacity: number } {
	return { queued: pendingJobs.length, scheduled: scheduledJobs.size, retries: retryState.size, capacity: maxQueuedJobs };
}

async function generate(candidate: UiNotificationSummaryCandidate): Promise<NotificationAgentSummary> {
	const { configModule, storeModule, notificationModule, idsModule } = await rootModules();
	const config = configModule.loadConfig();
	const store = new storeModule.OperationalStore(config.databasePath);
	store.migrate();
	const cached = parseSummary(store.getModelCache(candidate.cacheKey)?.output, candidate.actionRequired);
	if (cached) return cached;

	const callId = idsModule.newId("call");
	const startedAt = new Date().toISOString();
	store.recordModelCall({
		callId, workflow: "ui-notification-summary", taskType: "bounded_summary",
		model: candidate.model, promptVersion: candidate.promptVersion,
		sourceHash: candidate.sourceHash, contextHash: candidate.manifest.contextHash,
		cached: false, startedAt, status: "started",
	});
	store.recordContextManifest({
		manifestId: candidate.manifest.manifestId, callId,
		includedItems: candidate.manifest.includedItems, omittedItems: candidate.manifest.omittedItems,
		tokenBudget: candidate.manifest.tokenBudget, retrievalLevels: candidate.manifest.retrievalLevels,
		rankingVersion: candidate.manifest.rankingVersion, contextHash: candidate.manifest.contextHash,
		createdAt: candidate.manifest.createdAt,
	});

	try {
		const groundedContext = candidate.manifest.includedItems.map((item) => item.content);
		summaryClient ??= new CodexAppServerClient();
		let summary: NotificationAgentSummary | undefined;
		let validationError: unknown;
		for (let attempt = 0; attempt < 2 && !summary; attempt += 1) {
			const conversationId = `conversation_summary_${candidate.cacheKey.slice(-18)}_${attempt}`;
			try {
				const text = await summaryClient.streamTurn({
					sessionId: summarySessionId,
					conversationId,
					model: candidate.model,
					effort: "low",
					outputSchema: summaryOutputSchema,
					maxOutputCharacters: 1_000,
					message: `${attempt === 0 ? "Create" : "Repair and create"} a concise user-facing reaction to this LifeOS notification using only the grounded context below. Do not call tools. Return exactly 2 or 3 short sentences and set actionRequired to ${candidate.actionRequired}. Do not include identifiers, hashes, addresses, URLs, HTML, file paths, or source excerpts. Return only the requested structured output.\n\nGrounded context:\n${JSON.stringify(groundedContext)}`,
					onDelta: () => undefined,
				});
				summary = normalizeSummary(text, candidate.actionRequired);
			} catch (error) {
				validationError = error;
			} finally {
				await summaryClient.releaseConversation(summarySessionId, conversationId);
			}
		}
		if (!summary) throw validationError ?? new Error("Notification summary validation failed");

		const current = notificationModule.compileUiNotificationBundle().summaryCandidates
			.find((item) => item.notificationId === candidate.notificationId);
		if (!current || current.cacheKey !== candidate.cacheKey
			|| current.sourceHash !== candidate.sourceHash
			|| current.manifest.contextHash !== candidate.manifest.contextHash) {
			throw new Error("Notification changed while its summary was being generated");
		}
		store.putModelCache({
			cacheKey: candidate.cacheKey, workflow: "ui-notification-summary",
			promptVersion: candidate.promptVersion, model: candidate.model,
			sourceHash: candidate.sourceHash, contextHash: candidate.manifest.contextHash,
			schemaVersion: candidate.schemaVersion, policyVersion: candidate.policyVersion,
			output: summary, createdAt: new Date().toISOString(),
		});
		store.recordModelCall({
			callId, workflow: "ui-notification-summary", taskType: "bounded_summary",
			model: candidate.model, promptVersion: candidate.promptVersion,
			sourceHash: candidate.sourceHash, contextHash: candidate.manifest.contextHash,
			cached: false, startedAt, completedAt: new Date().toISOString(), status: "completed",
		});
		return summary;
	} catch (error) {
		store.recordModelCall({
			callId, workflow: "ui-notification-summary", taskType: "bounded_summary",
			model: candidate.model, promptVersion: candidate.promptVersion,
			sourceHash: candidate.sourceHash, contextHash: candidate.manifest.contextHash,
			cached: false, startedAt, completedAt: new Date().toISOString(), status: "failed",
			error: error instanceof Error ? error.message : "Notification summary failed",
		});
		throw error;
	}
}

const summaryOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["sentences", "actionRequired"],
	properties: {
		sentences: {
			type: "array", minItems: 2, maxItems: 3,
			items: { type: "string", minLength: 1, maxLength: 180 },
		},
		actionRequired: { type: "boolean" },
	},
} as const;

const forbiddenSummaryContent = /(?:sha256:|https?:\/\/|(?:^|\s)(?:~\/|\/Users\/|[A-Za-z]:\\)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:message|thread|event|proposal|state|call|manifest|cache|run|action)_[A-Za-z0-9_-]+\b|\b[a-f0-9]{40,}\b|<[^>]+>)/i;

export function normalizeSummary(text: string, expectedActionRequired: boolean): NotificationAgentSummary {
	if (text.length > 1_000) throw new Error("Notification summary output exceeds the transport bound");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Notification summary is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
	}
	return validateSummary(value, expectedActionRequired);
}

function parseSummary(value: unknown, expectedActionRequired: boolean): NotificationAgentSummary | undefined {
	try {
		return validateSummary(value, expectedActionRequired);
	} catch {
		return undefined;
	}
}

function validateSummary(value: unknown, expectedActionRequired: boolean): NotificationAgentSummary {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Notification summary must be an object");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => key !== "sentences" && key !== "actionRequired")) {
		throw new Error("Notification summary contains unexpected fields");
	}
	if (!Array.isArray(record.sentences) || record.sentences.length < 2 || record.sentences.length > 3) {
		throw new Error("Notification summary must contain 2-3 sentences");
	}
	if (record.actionRequired !== expectedActionRequired) throw new Error("Notification summary action state is inconsistent");
	const sentences = record.sentences.map((item) => {
		if (typeof item !== "string") throw new Error("Notification summary sentence must be text");
		const sentence = item.replace(/\s+/g, " ").trim();
		if (!sentence || sentence.length > 180) throw new Error("Notification summary sentence exceeds its bound");
		if (forbiddenSummaryContent.test(sentence)) throw new Error("Notification summary contains private or unsafe output");
		return sentence;
	});
	if (sentences.join(" ").length > 420) throw new Error("Notification summary exceeds its total bound");
	return { sentences, actionRequired: expectedActionRequired };
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
