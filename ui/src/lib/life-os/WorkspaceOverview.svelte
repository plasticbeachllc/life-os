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

<section class="border-b bg-muted/15 px-5 py-4 sm:px-6" aria-labelledby="workspace-heading">
	<div class="flex items-center justify-between gap-3">
		<div>
			<p class="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">Sources · Findings · State · Proposals</p>
			<h2 id="workspace-heading" class="mt-1 text-sm font-semibold">Operational overview</h2>
		</div>
		<div class="flex items-center gap-2">
			{#if workspace.refresh.available}
				<button class="text-xs underline disabled:opacity-60" disabled={refreshState === "refreshing"} onclick={onRefresh}>{refreshState === "refreshing" ? "Refreshing…" : workspace.refresh.label}</button>
			{/if}
			<Badge variant={workspace.mode === "live" || workspace.mode === "empty" ? "secondary" : "outline"}>{workspace.mode.replace("_", " ")}</Badge>
		</div>
	</div>

	<div class="mt-3 grid grid-cols-5 gap-1.5" aria-label="Attention queues">
		{#each workspace.attention as queue}
			<div class="rounded-lg border bg-background px-2 py-2 text-center" title={queue.freshness}>
				<p class="text-lg font-semibold leading-none">{queue.count}</p>
				<p class="mt-1 truncate text-[10px] text-muted-foreground">{labels[queue.category]}</p>
			</div>
		{/each}
	</div>

	<div class="mt-3 flex flex-wrap gap-1.5" aria-label="Provider health">
		{#each workspace.sources as source}
			<Badge variant="outline" class={source.health === "failed" ? "border-rose-300 text-rose-700" : source.health === "partial" ? "border-amber-300 text-amber-700" : ""}>
				<span class={`mr-1 size-1.5 rounded-full ${source.health === "healthy" ? "bg-emerald-500" : source.health === "disabled" ? "bg-muted-foreground" : source.health === "partial" ? "bg-amber-500" : "bg-rose-500"}`}></span>
				{source.provider}
			</Badge>
		{/each}
	</div>

	<div class="mt-3 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
		<p><strong class="text-foreground">{workspace.findings.active}</strong> active findings</p>
		<p><strong class="text-foreground">{workspace.proposals.length}</strong> proposals</p>
		<p><strong class="text-foreground">{workspace.work.pending}</strong> queued</p>
	</div>
	{#if workspace.feedback.total > 0}
		<p class="mt-2 text-[11px] text-muted-foreground">{workspace.feedback.total} suggestions reviewed · {workspace.feedback.useful} useful · {workspace.feedback.negative} other outcomes</p>
	{/if}
	{#if workspace.proposals[0]}
		<div class="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs">
			<div class="flex items-center justify-between gap-2"><strong>Approval {workspace.proposals[0].approval}</strong><span>{workspace.proposals[0].effectType.replaceAll("_", " ")}</span></div>
			<p class="mt-1 line-clamp-2 whitespace-pre-line text-muted-foreground">{workspace.proposals[0].preview}</p>
			<div class="mt-2 flex gap-2"><button class="underline" onclick={() => feedback("proposal", workspace.proposals[0].id, "accepted")}>Useful proposal</button><button class="underline" onclick={() => feedback("proposal", workspace.proposals[0].id, "rejected")}>Not useful</button></div>
		</div>
	{/if}
	{#if workspace.findings.items[0]}
		<div class="mt-2 text-xs text-muted-foreground">Latest finding: {workspace.findings.items[0].kind.replaceAll("_", " ")} · <button class="underline" onclick={() => feedback("finding", workspace.findings.items[0].id, "useful")}>Useful</button> / <button class="underline" onclick={() => feedback("finding", workspace.findings.items[0].id, "not_useful")}>Not useful</button>
			{#if workspace.findings.items[0].canProposeTask}<button class="ml-2 underline disabled:opacity-60" disabled={proposalState === "creating"} onclick={() => onProposeFinding(workspace.findings.items[0].id)}>{proposalState === "creating" ? "Creating proposal…" : "Create inbox proposal"}</button>{/if}
		</div>
	{/if}
	{#if feedbackState !== "idle"}<p class="mt-1 text-[11px] text-muted-foreground">Feedback {feedbackState}.</p>{/if}
	{#if workspace.actions[0]}
		<p class="mt-2 text-xs text-muted-foreground">Latest action: {workspace.actions[0].result} · Undo {workspace.actions[0].undo}</p>
	{/if}
	<p class="mt-2 truncate text-[11px] text-muted-foreground" title={workspace.state.provenance}>{workspace.state.freshness} · {workspace.state.provenance}</p>
	{#if workspace.message}<p class="mt-2 text-xs text-amber-700">{workspace.message}</p>{/if}
	{#if refreshState === "failed"}<p class="mt-2 text-xs text-rose-700">Refresh could not complete. Your existing workspace was left unchanged.</p>{/if}
	{#if proposalState === "failed"}<p class="mt-2 text-xs text-rose-700">The proposal could not be created. Nothing was written to the vault.</p>{/if}
</section>
