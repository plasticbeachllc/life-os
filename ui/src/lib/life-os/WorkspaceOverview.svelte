<script lang="ts">
	import { Badge } from "$lib/components/ui/badge";
	import type { WorkspaceSnapshot } from "./types";

	let { workspace, feedbackToken, refreshState, proposalState, onRefresh, onProposeFinding }: {
		workspace: WorkspaceSnapshot; feedbackToken: string;
		refreshState: "idle" | "refreshing" | "failed";
		proposalState: "idle" | "creating" | "failed";
		onRefresh: () => void;
		onProposeFinding: (findingUiId: string) => void;
	} = $props();
	const labels = { reply: "Replies", open_loop: "Open loops", date: "Dates", relationship: "People", project: "Projects" };
	let feedbackState = $state<"idle" | "saving" | "saved" | "failed">("idle");

	async function feedback(subjectKind: "finding" | "proposal", subjectUiId: string, outcome: string) {
		feedbackState = "saving";
		try {
			const response = await fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ subjectKind, subjectUiId, outcome, csrfToken: feedbackToken }) });
			feedbackState = response.ok ? "saved" : "failed";
		} catch { feedbackState = "failed"; }
	}
</script>

<section class="border-b bg-muted/10 px-5 py-3 sm:px-6" aria-labelledby="workspace-heading">
	<div class="flex items-center justify-between gap-3">
		<div>
			<h2 id="workspace-heading" class="text-sm font-semibold">Workspace</h2>
			<p class="mt-0.5 text-[11px] text-muted-foreground">{workspace.state.freshness}</p>
		</div>
		<div class="flex items-center gap-2">
			{#if workspace.refresh.available}
				<button class="text-xs underline disabled:opacity-60" disabled={refreshState === "refreshing"} onclick={onRefresh}>{refreshState === "refreshing" ? "Refreshing…" : workspace.refresh.label}</button>
			{/if}
			<Badge variant={workspace.mode === "live" || workspace.mode === "empty" ? "secondary" : "outline"}>{workspace.mode.replace("_", " ")}</Badge>
		</div>
	</div>

	<div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs" aria-label="Attention queues">
		{#each workspace.attention as queue}
			<span title={queue.freshness}><strong>{queue.count}</strong> <span class="text-muted-foreground">{labels[queue.category]}</span></span>
		{/each}
	</div>

	<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
		<div class="flex flex-wrap items-center gap-2" aria-label="Provider health">
			{#each workspace.sources as source}
				<span class={source.health === "failed" ? "text-rose-700" : source.health === "partial" ? "text-amber-700" : ""}>
					<span class={`mr-1 inline-block size-1.5 rounded-full ${source.health === "healthy" ? "bg-emerald-500" : source.health === "disabled" ? "bg-muted-foreground" : source.health === "partial" ? "bg-amber-500" : "bg-rose-500"}`}></span>{source.provider}
				</span>
			{/each}
		</div>
		<span aria-hidden="true">·</span>
		<span>{workspace.findings.active} findings</span>
		<span>{workspace.work.pending} queued</span>
		{#if workspace.feedback.total + workspace.feedback.handled > 0}<span>{workspace.feedback.useful}/{workspace.feedback.total} useful · {workspace.feedback.handled} handled</span>{/if}
	</div>
	{#if workspace.proposals[0]}
		<div class="mt-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs">
			<div class="flex items-center justify-between gap-2"><strong>Approval {workspace.proposals[0].approval}</strong><span>{workspace.proposals[0].effectType.replaceAll("_", " ")}</span></div>
			<p class="mt-1 line-clamp-2 whitespace-pre-line text-muted-foreground">{workspace.proposals[0].preview}</p>
			<div class="mt-2 flex gap-2"><button class="underline" onclick={() => feedback("proposal", workspace.proposals[0].id, "accepted")}>Useful proposal</button><button class="underline" onclick={() => feedback("proposal", workspace.proposals[0].id, "rejected")}>Not useful</button></div>
		</div>
	{/if}
	{#if workspace.findings.items[0]?.canProposeTask}
		<button class="mt-2 text-[11px] text-muted-foreground underline disabled:opacity-60" disabled={proposalState === "creating"} onclick={() => onProposeFinding(workspace.findings.items[0].id)}>{proposalState === "creating" ? "Creating proposal…" : "Draft task from latest finding"}</button>
	{/if}
	{#if feedbackState !== "idle"}<p class="mt-1 text-[11px] text-muted-foreground">Feedback {feedbackState}.</p>{/if}
	{#if workspace.actions[0]}
		<p class="mt-2 text-xs text-muted-foreground">Latest action: {workspace.actions[0].result} · Undo {workspace.actions[0].undo}</p>
	{/if}
	{#if workspace.message}<p class="mt-2 text-xs text-amber-700">{workspace.message}</p>{/if}
	{#if refreshState === "failed"}<p class="mt-2 text-xs text-rose-700">Refresh could not complete. Your existing workspace was left unchanged.</p>{/if}
	{#if proposalState === "failed"}<p class="mt-2 text-xs text-rose-700">The proposal could not be created. Nothing was written to the vault.</p>{/if}
</section>
