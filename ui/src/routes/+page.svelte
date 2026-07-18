<script lang="ts">
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import ChatPanel from "$lib/life-os/ChatPanel.svelte";
	import { initialMessages } from "$lib/life-os/initial-messages";
	import NotificationInbox from "$lib/life-os/NotificationInbox.svelte";
	import type { AttentionFeedbackOutcome, InboxNotification } from "$lib/life-os/types";
	import WorkspaceOverview from "$lib/life-os/WorkspaceOverview.svelte";
	import { Inbox, MessageCircle, Settings2, Sparkles } from "@lucide/svelte";
	import { onMount, untrack } from "svelte";
	import type { PageData } from "./$types";

	let { data }: { data: PageData } = $props();

	let activeMobilePanel = $state<"inbox" | "chat">("inbox");
	let selectedNotification = $state<InboxNotification | null>(null);
	let notifications = $state<InboxNotification[]>(
		untrack(() => data.notifications.map((notification: InboxNotification) => ({ ...notification }))),
	);
	let refreshState = $state<"idle" | "refreshing" | "failed">("idle");
	let proposalState = $state<"idle" | "creating" | "failed">("idle");
	let feedbackStates = $state<Record<string, "saving" | "saved" | "failed">>({});
	let feedbackOutcomes = $state<Record<string, AttentionFeedbackOutcome>>({});
	let handledStates = $state<Record<string, "saving" | "failed">>({});

	onMount(() => {
		const releaseSession = () => {
			void fetch("/api/chat/session", { method: "DELETE", keepalive: true });
		};
		window.addEventListener("pagehide", releaseSession);
		return () => window.removeEventListener("pagehide", releaseSession);
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
		refreshState = "refreshing";
		try {
			const response = await fetch("/api/today/refresh", { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ csrfToken: data.refreshToken }) });
			if (!response.ok) throw new Error("refresh failed");
			window.location.reload();
		} catch { refreshState = "failed"; }
	}

	async function proposeFindingTask(findingUiId: string) {
		proposalState = "creating";
		try {
			const response = await fetch("/api/findings/propose-task", { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ findingUiId, csrfToken: data.feedbackToken }) });
			if (!response.ok) throw new Error("proposal failed");
			window.location.reload();
		} catch { proposalState = "failed"; }
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
			<div class="flex items-baseline gap-2">
				<span class="font-semibold tracking-tight">LifeOS</span>
				<Badge variant="outline" class="hidden sm:inline-flex">Private beta</Badge>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<div class="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
				<span class="size-2 rounded-full bg-emerald-500"></span>
				Read-only mode
			</div>
			<Button variant="ghost" size="icon" aria-label="Open settings">
				<Settings2 aria-hidden="true" />
			</Button>
		</div>
	</header>

	<main class="grid min-h-0 flex-1 md:grid-cols-[minmax(320px,42%)_minmax(0,58%)]">
		<div class:hidden={activeMobilePanel !== "inbox"} class="min-h-0 flex-col md:flex md:border-r">
			<WorkspaceOverview workspace={data.workspace} feedbackToken={data.feedbackToken} {refreshState} {proposalState} onRefresh={refreshToday} onProposeFinding={proposeFindingTask} />
			<div class="min-h-0 flex-1"><NotificationInbox
				{notifications}
				selectedId={selectedNotification?.id ?? null}
				onSelect={selectNotification}
				onAction={handleNotificationAction}
				onFeedback={handleAttentionFeedback}
				onHandled={handleAttentionHandled}
				{feedbackStates}
				{feedbackOutcomes}
				{handledStates}
			/></div>
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
