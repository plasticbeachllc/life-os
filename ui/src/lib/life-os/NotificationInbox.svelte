<script lang="ts">
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { ScrollArea } from "$lib/components/ui/scroll-area";
	import { CalendarDays, Check, CircleHelp, ListTodo, Mail, Send, ShieldCheck } from "@lucide/svelte";
	import type { InboxNotification, NotificationCategory, NotificationKind, NotificationTone } from "./types";

	type Filter = "all" | NotificationCategory;

	let {
		notifications,
		selectedId,
		onSelect,
		onAction,
	}: {
		notifications: InboxNotification[];
		selectedId: string | null;
		onSelect: (notification: InboxNotification) => void;
		onAction: (notification: InboxNotification, action: "primary" | "secondary") => void;
	} = $props();

	let filter = $state<Filter>("for_you");
	let visibleNotifications = $derived(
		filter === "all" ? notifications : notifications.filter((item) => item.category === filter),
	);

	const filters: Array<{ value: Filter; label: string }> = [
		{ value: "for_you", label: "For you" },
		{ value: "activity", label: "Activity" },
		{ value: "approvals", label: "Approvals" },
		{ value: "all", label: "All" },
	];

	function iconFor(kind: NotificationKind) {
		return kind === "email"
			? Mail
			: kind === "calendar"
				? CalendarDays
				: kind === "proposal"
					? Send
					: kind === "task"
						? ListTodo
						: ShieldCheck;
	}

	function iconClasses(tone: NotificationTone) {
		return tone === "proposal"
			? "bg-amber-100 text-amber-800"
			: tone === "question"
				? "bg-sky-100 text-sky-800"
				: tone === "receipt"
					? "bg-emerald-100 text-emerald-800"
					: "bg-muted text-muted-foreground";
	}
</script>

<section class="flex min-h-0 flex-1 flex-col bg-background" aria-labelledby="inbox-heading">
	<div class="space-y-4 border-b px-5 py-5 sm:px-6">
		<div class="flex items-start justify-between gap-4">
			<div>
				<p class="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">Handled and waiting</p>
				<h1 id="inbox-heading" class="mt-1 text-2xl font-semibold tracking-tight">Inbox</h1>
			</div>
			<Badge variant="secondary" class="mt-1">
				{notifications.filter((item) => item.status === "open" && item.category !== "activity").length} need you
			</Badge>
		</div>

		<div class="flex gap-1 overflow-x-auto" aria-label="Filter notifications">
			{#each filters as item}
				<Button
					variant={filter === item.value ? "secondary" : "ghost"}
					size="sm"
					onclick={() => (filter = item.value)}
					aria-pressed={filter === item.value}
				>
					{item.label}
					{#if item.value === "approvals"}
						<span class="ml-0.5 rounded-full bg-amber-500 px-1.5 text-[10px] leading-4 text-white">
							{notifications.filter((notification) => notification.category === "approvals" && notification.status === "open").length}
						</span>
					{/if}
				</Button>
			{/each}
		</div>
	</div>

	<ScrollArea class="min-h-0 flex-1">
		<div class="space-y-2 p-3 sm:p-4">
			{#each visibleNotifications as notification (notification.id)}
				{@const Icon = iconFor(notification.kind)}
				<article
					class={`group rounded-xl border bg-card p-4 text-card-foreground transition hover:border-foreground/20 hover:shadow-sm ${selectedId === notification.id ? "border-foreground/30 bg-accent/40" : ""} ${notification.status === "resolved" ? "opacity-70" : ""}`}
				>
					<button class="w-full text-left" onclick={() => onSelect(notification)}>
						<div class="flex gap-3">
							<div class={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg ${iconClasses(notification.tone)}`}>
								<Icon class="size-4" aria-hidden="true" />
							</div>
							<div class="min-w-0 flex-1">
								<div class="flex items-start justify-between gap-3">
									<h2 class="text-sm font-semibold leading-5">{notification.title}</h2>
									{#if notification.status === "resolved"}
										<Check class="mt-0.5 size-4 shrink-0 text-emerald-600" aria-label="Resolved" />
									{:else if notification.tone === "question"}
										<CircleHelp class="mt-0.5 size-4 shrink-0 text-sky-600" aria-label="Needs clarification" />
									{:else if notification.tone === "proposal"}
										<span class="mt-1 size-2 shrink-0 rounded-full bg-amber-500" aria-label="Approval required"></span>
									{/if}
								</div>
								<p class="mt-1 text-sm leading-5 text-muted-foreground">{notification.summary}</p>
								{#if notification.detail}<p class="mt-2 text-xs font-medium text-muted-foreground">{notification.detail}</p>{/if}
								<p class="mt-2 text-xs text-muted-foreground">{notification.relativeTime}</p>
							</div>
						</div>
					</button>
					{#if notification.status === "open" && (notification.primaryAction || notification.secondaryAction)}
						<div class="mt-3 flex justify-end gap-2 border-t pt-3">
							{#if notification.secondaryAction}
								<Button variant="ghost" size="sm" onclick={() => onAction(notification, "secondary")}>
									{notification.secondaryAction.label}
								</Button>
							{/if}
							{#if notification.primaryAction}
								<Button
									variant={notification.tone === "proposal" ? "default" : "outline"}
									size="sm"
									onclick={() => onAction(notification, "primary")}
								>
									{notification.primaryAction.label}
								</Button>
							{/if}
						</div>
					{/if}
				</article>
			{:else}
				<div class="flex min-h-56 flex-col items-center justify-center text-center">
					<Check class="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
					<p class="font-medium">Nothing here</p>
					<p class="mt-1 text-sm text-muted-foreground">LifeOS has this view handled.</p>
				</div>
			{/each}
		</div>
	</ScrollArea>
</section>
