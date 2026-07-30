import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserConfirmation } from "./chat-session";

export interface PreparedBrowserTaskAction {
	subjectUiId: string;
	preview: string;
	authorizationToken: string;
	actionId: string;
	proposalId?: string;
	expiresAt: number;
}

export async function proposeTaskFromAttention(attentionUiId: string): Promise<{
	proposalUiId: string;
	preview: string;
}> {
	const context = await loadContext();
	const proposal = await context.modules.browserActions.proposeAttentionTaskFromUi({
		attentionUiId,
		vault: context.vault,
		store: context.store,
	});
	return { proposalUiId: proposal.id, preview: proposal.preview };
}

export async function prepareTaskProposal(proposalUiId: string): Promise<PreparedBrowserTaskAction> {
	const context = await loadContext();
	const proposal = context.modules.browserActions.requirePendingTaskProposalFromUi({
		proposalUiId,
		store: context.store,
	});
	const authorization = await context.modules.authorization.prepareProposalAuthorization({
		proposalId: proposal.proposalId,
		vault: context.vault,
		store: context.store,
		ttlSeconds: 300,
	});
	const review = context.modules.review.browserProposalReview(proposal);
	return {
		subjectUiId: proposalUiId,
		preview: review.preview,
		authorizationToken: authorization.token,
		proposalId: proposal.proposalId,
		actionId: proposal.actionId,
		expiresAt: new Date(authorization.expiresAt).getTime(),
	};
}

export async function applyTaskProposal(confirmation: BrowserConfirmation): Promise<{
	status: "completed";
	title: string;
	summary: string;
	undoAvailable: true;
	projectionStatus: "completed" | "partial";
}> {
	if (confirmation.purpose !== "apply_task_proposal" || !confirmation.proposalId) {
		throw new Error("invalid task proposal confirmation");
	}
	const context = await loadContext();
	const proposal = context.store.getProposal(confirmation.proposalId);
	if (!proposal || proposal.actionId !== confirmation.actionId || proposal.effectType !== "finding_task_append") {
		throw new Error("confirmed task proposal is unavailable");
	}
	await context.modules.apply.applyProposalWithAuthorization({
		token: confirmation.authorizationToken,
		proposalId: proposal.proposalId,
		actionId: proposal.actionId,
		vault: context.vault,
		store: context.store,
		backupRoot: context.config.backupPath,
	});
	const projectionStatus = await rebuildSafely(context);
	return {
		status: "completed",
		title: "Task added to Inbox",
		summary: context.modules.review.browserProposalReview(proposal).preview,
		undoAvailable: true,
		projectionStatus,
	};
}

export async function prepareTaskUndo(actionUiId: string): Promise<PreparedBrowserTaskAction> {
	const context = await loadContext();
	const action = context.modules.browserActions.requireUndoableTaskActionFromUi({
		actionUiId,
		store: context.store,
	});
	const authorization = await context.modules.authorization.prepareUndoAuthorization({
		actionId: action.actionId,
		vault: context.vault,
		store: context.store,
		ttlSeconds: 300,
	});
	return {
		subjectUiId: actionUiId,
		preview: context.modules.review.browserProposalReview(action.proposal).preview,
		authorizationToken: authorization.token,
		actionId: action.actionId,
		expiresAt: new Date(authorization.expiresAt).getTime(),
	};
}

export async function undoTaskAction(confirmation: BrowserConfirmation): Promise<{
	status: "undone";
	title: string;
	summary: string;
	projectionStatus: "completed" | "partial";
}> {
	if (confirmation.purpose !== "undo_task_action") throw new Error("invalid task undo confirmation");
	const context = await loadContext();
	const proposal = context.store.getProposalByActionId(confirmation.actionId);
	if (!proposal || proposal.effectType !== "finding_task_append") {
		throw new Error("confirmed task action is unavailable");
	}
	await context.modules.authorization.consumeUndoAuthorization({
		token: confirmation.authorizationToken,
		actionId: confirmation.actionId,
		vault: context.vault,
		store: context.store,
	});
	await context.modules.undo.undoAction({
		actionId: confirmation.actionId,
		vault: context.vault,
		store: context.store,
	});
	const projectionStatus = await rebuildSafely(context);
	return {
		status: "undone",
		title: "Task creation undone",
		summary: context.modules.review.browserProposalReview(proposal).preview,
		projectionStatus,
	};
}

interface LoadedModules {
	config: typeof import("../../../../src/config");
	store: typeof import("../../../../src/db/store");
	obsidian: typeof import("../../../../src/adapters/obsidian");
	browserActions: typeof import("../../../../src/ui/browser-actions");
	authorization: typeof import("../../../../src/policy/authorization");
	apply: typeof import("../../../../src/tools/apply-proposal");
	undo: typeof import("../../../../src/tools/undo-action");
	rebuild: typeof import("../../../../src/workflows/rebuild-state");
	review: typeof import("../../../../src/effects/review-projection");
}

interface ActionContext {
	modules: LoadedModules;
	config: ReturnType<LoadedModules["config"]["loadConfig"]>;
	store: InstanceType<LoadedModules["store"]["OperationalStore"]>;
	vault: InstanceType<LoadedModules["obsidian"]["ObsidianVault"]>;
}

async function loadContext(): Promise<ActionContext> {
	const root = repositoryRoot();
	const urls = (path: string) => pathToFileURL(resolve(root, path)).href;
	const [config, store, obsidian, browserActions, authorization, apply, undo, rebuild, review] = await Promise.all([
		import(/* @vite-ignore */ urls("src/config.ts")) as Promise<LoadedModules["config"]>,
		import(/* @vite-ignore */ urls("src/db/store.ts")) as Promise<LoadedModules["store"]>,
		import(/* @vite-ignore */ urls("src/adapters/obsidian.ts")) as Promise<LoadedModules["obsidian"]>,
		import(/* @vite-ignore */ urls("src/ui/browser-actions.ts")) as Promise<LoadedModules["browserActions"]>,
		import(/* @vite-ignore */ urls("src/policy/authorization.ts")) as Promise<LoadedModules["authorization"]>,
		import(/* @vite-ignore */ urls("src/tools/apply-proposal.ts")) as Promise<LoadedModules["apply"]>,
		import(/* @vite-ignore */ urls("src/tools/undo-action.ts")) as Promise<LoadedModules["undo"]>,
		import(/* @vite-ignore */ urls("src/workflows/rebuild-state.ts")) as Promise<LoadedModules["rebuild"]>,
		import(/* @vite-ignore */ urls("src/effects/review-projection.ts")) as Promise<LoadedModules["review"]>,
	]);
	const modules = { config, store, obsidian, browserActions, authorization, apply, undo, rebuild, review };
	const loaded = config.loadConfig();
	const operationalStore = new store.OperationalStore(loaded.databasePath);
	operationalStore.migrate();
	return {
		modules,
		config: loaded,
		store: operationalStore,
		vault: new obsidian.ObsidianVault(loaded.vaultPath),
	};
}

async function rebuildSafely(context: ActionContext): Promise<"completed" | "partial"> {
	try {
		await context.modules.rebuild.rebuildState({
			vault: context.vault,
			store: context.store,
		});
		return "completed";
	} catch {
		return "partial";
	}
}

function repositoryRoot(): string {
	const configured = process.env.LIFE_OS_REPO_PATH;
	if (configured) return resolve(configured);
	const cwd = process.cwd();
	if (existsSync(resolve(cwd, "src/db/schema.ts"))) return cwd;
	if (existsSync(resolve(cwd, "../src/db/schema.ts"))) return resolve(cwd, "..");
	throw new Error("LifeOS repository root was not found");
}
