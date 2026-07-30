<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import ChatPanel from "$lib/life-os/ChatPanel.svelte";
	import { initialMessages } from "$lib/life-os/initial-messages";
	import NotificationInbox from "$lib/life-os/NotificationInbox.svelte";
	import type { AttentionFeedbackOutcome, InboxNotification } from "$lib/life-os/types";
	import { Inbox, MessageCircle, RefreshCw, Sparkles } from "@lucide/svelte";
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

	onMount(() => {
		void pollProcessingStatus();
		const poller = window.setInterval(() => void pollProcessingStatus(), 1_500);
		const releaseSession = () => {
			void fetch("/api/chat/session", { method: "DELETE", keepalive: true });
		};
		window.addEventListener("pagehide", releaseSession);
		return () => {
			window.clearInterval(poller);
			window.removeEventListener("pagehide", releaseSession);
		};
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

	function handleNotificationAction(notification: InboxNotification, position: "primary" | "secondary") {
		const action = position === "primary" ? notification.primaryAction : notification.secondaryAction;
		if (!action) return;

		if (action.kind === "resolve" || action.kind === "review" || action.kind === "discuss") {
			void submitAttentionFeedback(notification, "useful");
			discussNotification(notification);
			return;
		}
		if (action.kind === "dismiss") void submitAttentionFeedback(notification, "irrelevant");

		notifications = notifications.map((item) => {
			if (item.id !== notification.id) return item;
			if (action.kind === "undo") {
				return {
					...item,
					status: "resolved",
					tone: "update",
					title: "Task creation undone",
					summary: "The automatically created task was removed.",
				};
			}
			return { ...item, status: "resolved" };
		});
		if (selectedNotification?.id === notification.id) selectedNotification = null;
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
</div>
