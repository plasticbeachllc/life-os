<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import { Textarea } from "$lib/components/ui/textarea";
	import ChatPanel from "$lib/life-os/ChatPanel.svelte";
	import { initialMessages } from "$lib/life-os/initial-messages";
	import NotificationInbox from "$lib/life-os/NotificationInbox.svelte";
	import type { AttentionFeedbackOutcome, InboxNotification } from "$lib/life-os/types";
	import { Copy, ExternalLink, Inbox, MessageCircle, RefreshCw, Sparkles } from "@lucide/svelte";
	import { onMount, untrack } from "svelte";
	import type { PageData } from "./$types";

	type ProcessingRun = {
		status: "queued" | "running" | "cancellation_requested" | "completed" | "partial" | "cancelled" | "failed" | "interrupted";
		stage: "queued" | "ingesting" | "extracting" | "projecting" | "complete";
		requested: { gmail: number; imessage: number };
		processed: { gmail: number; imessage: number };
		failed: { gmail: number; imessage: number };
		canCancel: boolean;
	};
	type ActionDialog = {
		purpose: "apply" | "undo";
		subjectUiId: string;
		confirmationId: string;
		title: string;
		preview: string;
		confirmLabel: string;
		state: "ready" | "saving" | "failed";
	};
	type EmailDraftDialog = {
		subjectUiId: string;
		status: "ready" | "needs_clarification";
		body: string;
		clarification: string | null;
		assumptions: string[];
		openEmailHref?: string;
		copyState: "idle" | "copied" | "failed";
	};

	let { data }: { data: PageData } = $props();

	let activeMobilePanel = $state<"inbox" | "chat">("inbox");
	let selectedNotification = $state<InboxNotification | null>(null);
	let notifications = $state<InboxNotification[]>(
		untrack(() => data.notifications.map((notification: InboxNotification) => ({ ...notification }))),
	);
	let refreshState = $state<"idle" | "starting" | "failed">("idle");
	let processingRun = $state<ProcessingRun | undefined>();
	let sawActiveProcessingRun = false;
	let feedbackStates = $state<Record<string, "saving" | "saved" | "failed">>({});
	let feedbackOutcomes = $state<Record<string, AttentionFeedbackOutcome>>({});
	let handledStates = $state<Record<string, "saving" | "failed">>({});
	let actionStates = $state<Record<string, "saving" | "failed">>({});
	let actionDialog = $state<ActionDialog | null>(null);
	let emailDraftDialog = $state<EmailDraftDialog | null>(null);

	onMount(() => {
		void pollProcessingStatus();
		const poller = window.setInterval(() => void pollProcessingStatus(), 1_500);
		return () => window.clearInterval(poller);
	});

	function selectNotification(notification: InboxNotification) {
		selectedNotification = notification;
	}

	function discussNotification(notification: InboxNotification) {
		selectedNotification = notification;
		activeMobilePanel = "chat";
	}

	async function submitAttentionFeedback(notification: InboxNotification, outcome: AttentionFeedbackOutcome): Promise<boolean> {
		if (notification.feedbackSubjectKind !== "attention") return false;
		try {
			const response = await fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ subjectKind: "attention", subjectUiId: notification.id,
					outcome, csrfToken: data.feedbackToken }) });
			return response.ok;
		} catch { return false; }
	}

	async function handleAttentionFeedback(notification: InboxNotification, outcome: AttentionFeedbackOutcome) {
		feedbackStates = { ...feedbackStates, [notification.id]: "saving" };
		const recorded = await submitAttentionFeedback(notification, outcome);
		feedbackStates = { ...feedbackStates, [notification.id]: recorded ? "saved" : "failed" };
		if (!recorded) return;
		feedbackOutcomes = { ...feedbackOutcomes, [notification.id]: outcome };
		if (outcome !== "useful") {
			notifications = notifications.map((item) => item.id === notification.id ? { ...item, status: "resolved" } : item);
			if (selectedNotification?.id === notification.id) selectedNotification = null;
		}
	}

	async function handleAttentionHandled(notification: InboxNotification) {
		if (notification.feedbackSubjectKind !== "attention") return;
		handledStates = { ...handledStates, [notification.id]: "saving" };
		try {
			const response = await fetch("/api/attention/handled", { method: "POST",
				headers: { "content-type": "application/json" }, body: JSON.stringify({
					subjectUiId: notification.id, csrfToken: data.feedbackToken,
				}) });
			if (!response.ok) throw new Error("handled action failed");
			notifications = notifications.map((item) => item.id === notification.id ? { ...item, status: "resolved" } : item);
			if (selectedNotification?.id === notification.id) selectedNotification = null;
		} catch { handledStates = { ...handledStates, [notification.id]: "failed" }; }
	}

	async function handleNotificationAction(notification: InboxNotification, position: "primary" | "secondary") {
		const action = position === "primary" ? notification.primaryAction : notification.secondaryAction;
		if (!action) return;

		if (action.kind === "propose_task") {
			await createTaskProposal(notification);
			return;
		}
		if (action.kind === "draft_email") {
			await prepareEmailDraft(notification);
			return;
		}
		if (action.kind === "approve") {
			await prepareTaskAction(notification, "apply");
			return;
		}
		if (action.kind === "undo") {
			await prepareTaskAction(notification, "undo");
			return;
		}
		if (action.kind === "resolve" || action.kind === "review" || action.kind === "discuss") {
			void submitAttentionFeedback(notification, "useful");
			discussNotification(notification);
			return;
		}
		if (action.kind === "dismiss") void submitAttentionFeedback(notification, "irrelevant");

		notifications = notifications.map((item) => {
			if (item.id !== notification.id) return item;
			return { ...item, status: "resolved" };
		});
		if (selectedNotification?.id === notification.id) selectedNotification = null;
	}

	async function prepareEmailDraft(notification: InboxNotification) {
		actionStates = { ...actionStates, [notification.id]: "saving" };
		try {
			const response = await fetch("/api/attention/draft-email", {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ attentionUiId: notification.id, csrfToken: data.feedbackToken }),
			});
			if (!response.ok) throw new Error("draft failed");
			const draft = await response.json() as {
				status: "ready" | "needs_clarification"; body: string | null;
				clarification: string | null; assumptions: string[];
			};
			emailDraftDialog = {
				subjectUiId: notification.id, status: draft.status, body: draft.body ?? "",
				clarification: draft.clarification, assumptions: draft.assumptions,
				...(notification.sourceAction ? { openEmailHref: notification.sourceAction.href } : {}),
				copyState: "idle",
			};
			const next = { ...actionStates }; delete next[notification.id]; actionStates = next;
		} catch {
			actionStates = { ...actionStates, [notification.id]: "failed" };
		}
	}

	function closeEmailDraft() {
		emailDraftDialog = null;
	}

	async function copyEmailDraft() {
		if (!emailDraftDialog?.body) return;
		try {
			await navigator.clipboard.writeText(emailDraftDialog.body);
			emailDraftDialog = { ...emailDraftDialog, copyState: "copied" };
		} catch {
			emailDraftDialog = { ...emailDraftDialog, copyState: "failed" };
		}
	}

	async function createTaskProposal(notification: InboxNotification) {
		actionStates = { ...actionStates, [notification.id]: "saving" };
		try {
			const response = await fetch("/api/attention/propose-task", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ attentionUiId: notification.id, csrfToken: data.feedbackToken }),
			});
			if (!response.ok) throw new Error("proposal failed");
			window.location.reload();
		} catch {
			actionStates = { ...actionStates, [notification.id]: "failed" };
		}
	}

	async function prepareTaskAction(notification: InboxNotification, purpose: "apply" | "undo") {
		actionStates = { ...actionStates, [notification.id]: "saving" };
		try {
			const endpoint = purpose === "apply" ? "/api/proposals/prepare" : "/api/actions/prepare-undo";
			const subject = purpose === "apply"
				? { proposalUiId: notification.id }
				: { actionUiId: notification.id };
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...subject, csrfToken: data.feedbackToken }),
			});
			if (!response.ok) throw new Error("prepare failed");
			const prepared = await response.json() as {
				confirmationId: string;
				title: string;
				preview: string;
				confirmLabel: string;
			};
			actionDialog = {
				purpose,
				subjectUiId: notification.id,
				confirmationId: prepared.confirmationId,
				title: prepared.title,
				preview: prepared.preview,
				confirmLabel: prepared.confirmLabel,
				state: "ready",
			};
			actionStates = { ...actionStates, [notification.id]: "saving" };
		} catch {
			actionStates = { ...actionStates, [notification.id]: "failed" };
		}
	}

	function closeActionDialog() {
		if (!actionDialog || actionDialog.state === "saving") return;
		const subjectUiId = actionDialog.subjectUiId;
		actionDialog = null;
		const next = { ...actionStates };
		delete next[subjectUiId];
		actionStates = next;
	}

	async function confirmTaskAction() {
		if (!actionDialog || actionDialog.state === "saving") return;
		actionDialog = { ...actionDialog, state: "saving" };
		try {
			const endpoint = actionDialog.purpose === "apply" ? "/api/proposals/apply" : "/api/actions/undo";
			const subject = actionDialog.purpose === "apply"
				? { proposalUiId: actionDialog.subjectUiId }
				: { actionUiId: actionDialog.subjectUiId };
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...subject,
					confirmationId: actionDialog.confirmationId,
					csrfToken: data.feedbackToken,
				}),
			});
			if (!response.ok) throw new Error("confirmation failed");
			window.location.reload();
		} catch {
			if (actionDialog) actionDialog = { ...actionDialog, state: "failed" };
		}
	}

	async function refreshToday() {
		refreshState = "starting";
		try {
			const response = await fetch("/api/today/refresh", { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ csrfToken: data.refreshToken }) });
			if (!response.ok) throw new Error("refresh failed");
			const payload = await response.json() as { run?: ProcessingRun };
			processingRun = payload.run;
			sawActiveProcessingRun = Boolean(payload.run?.canCancel);
			refreshState = "idle";
		} catch { refreshState = "failed"; }
	}

	async function cancelProcessing() {
		try {
			const response = await fetch("/api/today/refresh", { method: "DELETE", headers: { "content-type": "application/json" },
				body: JSON.stringify({ csrfToken: data.refreshToken }) });
			if (!response.ok) throw new Error("cancel failed");
			const payload = await response.json() as { run?: ProcessingRun };
			processingRun = payload.run;
		} catch { refreshState = "failed"; }
	}

	async function pollProcessingStatus() {
		try {
			const response = await fetch("/api/today/refresh");
			if (!response.ok) return;
			const payload = await response.json() as { run?: ProcessingRun };
			const wasActive = sawActiveProcessingRun;
			processingRun = payload.run;
			if (payload.run?.canCancel) sawActiveProcessingRun = true;
			if (wasActive && payload.run && !payload.run.canCancel) window.location.reload();
		} catch {
			// A transient status failure should not replace the current workspace with an error.
		}
	}

	function processingLabel(): string {
		if (refreshState === "starting" || processingRun?.status === "queued") return "Starting…";
		if (processingRun?.status === "cancellation_requested") return "Stopping…";
		if (processingRun?.status === "running") {
			if (processingRun.stage === "ingesting") return "Syncing…";
			if (processingRun.stage === "projecting") return "Updating…";
			const processed = processingRun.processed.gmail + processingRun.processed.imessage;
			const requested = processingRun.requested.gmail + processingRun.requested.imessage;
			return `Processing ${processed}/${requested}`;
		}
		return refreshState === "failed" ? "Try again" : "Sync & process";
	}

</script>

<svelte:head>
	<title>LifeOS</title>
	<meta name="description" content="A local-first inbox and agent workspace." />
</svelte:head>

<div class="flex h-dvh min-h-[560px] flex-col overflow-hidden bg-background">
	<header class="flex h-14 shrink-0 items-center justify-between border-b px-4 sm:px-6">
		<div class="flex items-center gap-2.5">
			<div class="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
				<Sparkles class="size-4" aria-hidden="true" />
			</div>
			<span class="font-semibold tracking-tight">LifeOS</span>
		</div>
		<div class="flex items-center gap-1">
			{#if processingRun?.canCancel}
				<Button variant="ghost" size="sm" onclick={cancelProcessing}>Stop</Button>
			{/if}
			<Button variant="ghost" size="sm" disabled={refreshState === "starting" || processingRun?.canCancel} onclick={refreshToday}>
				<RefreshCw class={refreshState === "starting" || processingRun?.canCancel ? "animate-spin" : ""} aria-hidden="true" />
				{processingLabel()}
			</Button>
		</div>
	</header>

	<main class="grid min-h-0 flex-1 md:grid-cols-[minmax(320px,42%)_minmax(0,58%)]">
		<div class:hidden={activeMobilePanel !== "inbox"} class="min-h-0 flex-col md:flex md:border-r">
			<NotificationInbox
				{notifications}
				selectedId={selectedNotification?.id ?? null}
				onSelect={selectNotification}
				onAction={handleNotificationAction}
				onFeedback={handleAttentionFeedback}
				onHandled={handleAttentionHandled}
				{feedbackStates}
				{feedbackOutcomes}
				{handledStates}
				{actionStates}
			/>
		</div>

		<div class:hidden={activeMobilePanel !== "chat"} class="min-h-0 md:flex">
			<ChatPanel
				{initialMessages}
				context={selectedNotification}
				onClearContext={() => (selectedNotification = null)}
			/>
		</div>
	</main>

	<nav class="grid h-16 shrink-0 grid-cols-2 border-t bg-background md:hidden" aria-label="Primary navigation">
		<Button
			variant="ghost"
			class={`h-full flex-col gap-1 rounded-none ${activeMobilePanel === "inbox" ? "bg-muted" : ""}`}
			onclick={() => (activeMobilePanel = "inbox")}
			aria-current={activeMobilePanel === "inbox" ? "page" : undefined}
		>
			<Inbox class="size-4" aria-hidden="true" />
			<span class="text-xs">Inbox</span>
		</Button>
		<Button
			variant="ghost"
			class={`h-full flex-col gap-1 rounded-none ${activeMobilePanel === "chat" ? "bg-muted" : ""}`}
			onclick={() => (activeMobilePanel = "chat")}
			aria-current={activeMobilePanel === "chat" ? "page" : undefined}
		>
			<MessageCircle class="size-4" aria-hidden="true" />
			<span class="text-xs">Chat</span>
		</Button>
	</nav>

	{#if actionDialog}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="presentation" onclick={closeActionDialog}>
			<div
				class="w-full max-w-md rounded-xl border bg-background p-5 shadow-xl"
				role="dialog"
				tabindex="-1"
				aria-modal="true"
				aria-labelledby="action-dialog-title"
				onclick={(event) => event.stopPropagation()}
				onkeydown={(event) => {
					event.stopPropagation();
					if (event.key === "Escape") closeActionDialog();
				}}
			>
				<h2 id="action-dialog-title" class="text-lg font-semibold">{actionDialog.title}</h2>
				<p class="mt-2 text-sm text-muted-foreground">
					{actionDialog.purpose === "apply"
						? "Review the exact task below. Nothing else will be changed."
						: "This removes the task that LifeOS added. Other Inbox changes are left alone."}
				</p>
				<div class="mt-4 rounded-lg border bg-muted/40 p-3 text-sm font-medium">{actionDialog.preview}</div>
				{#if actionDialog.state === "failed"}
					<p class="mt-3 text-sm text-rose-700">The state changed or confirmation expired. Close this review and try again.</p>
				{/if}
				<div class="mt-5 flex justify-end gap-2">
					<Button variant="ghost" disabled={actionDialog.state === "saving"} onclick={closeActionDialog}>Cancel</Button>
					<Button disabled={actionDialog.state !== "ready"} onclick={confirmTaskAction}>
						{actionDialog.state === "saving" ? "Working…" : actionDialog.confirmLabel}
					</Button>
				</div>
			</div>
		</div>
	{/if}

	{#if emailDraftDialog}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="presentation" onclick={closeEmailDraft}>
			<div class="w-full max-w-xl rounded-xl border bg-background p-5 shadow-xl" role="dialog"
				tabindex="-1" aria-modal="true" aria-labelledby="email-draft-title"
				onclick={(event) => event.stopPropagation()}
				onkeydown={(event) => { event.stopPropagation(); if (event.key === "Escape") closeEmailDraft(); }}>
				<h2 id="email-draft-title" class="text-lg font-semibold">
					{emailDraftDialog.status === "ready" ? "Draft response" : "One detail is needed"}
				</h2>
				{#if emailDraftDialog.status === "ready"}
					<p class="mt-2 text-sm text-muted-foreground">Review and edit this draft before sending it yourself. LifeOS cannot send email.</p>
					<Textarea bind:value={emailDraftDialog.body} class="mt-4 min-h-52 resize-y text-sm leading-6" aria-label="Email draft" />
					{#if emailDraftDialog.assumptions.length > 0}
						<div class="mt-3 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
							<p class="font-medium text-foreground">Check before sending</p>
							<ul class="mt-1 list-disc space-y-1 pl-4">
								{#each emailDraftDialog.assumptions as assumption}<li>{assumption}</li>{/each}
							</ul>
						</div>
					{/if}
				{:else}
					<p class="mt-3 rounded-lg bg-muted/50 p-3 text-sm">{emailDraftDialog.clarification}</p>
					<p class="mt-2 text-xs text-muted-foreground">Discuss the item to supply the missing detail, then prepare the draft again.</p>
				{/if}
				<div class="mt-5 flex flex-wrap justify-end gap-2">
					<Button variant="ghost" onclick={closeEmailDraft}>Close</Button>
					{#if emailDraftDialog.status === "ready"}
						<Button variant="outline" onclick={copyEmailDraft}>
							<Copy data-icon="inline-start" aria-hidden="true" />
							{emailDraftDialog.copyState === "copied" ? "Copied" : emailDraftDialog.copyState === "failed" ? "Copy failed" : "Copy draft"}
						</Button>
						{#if emailDraftDialog.openEmailHref}
							<Button href={emailDraftDialog.openEmailHref} target="_blank">
								<ExternalLink data-icon="inline-start" aria-hidden="true" />Open Gmail
							</Button>
						{/if}
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>
