<script lang="ts">
	import { Avatar, AvatarFallback } from "$lib/components/ui/avatar";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { ScrollArea } from "$lib/components/ui/scroll-area";
	import { Separator } from "$lib/components/ui/separator";
	import { Textarea } from "$lib/components/ui/textarea";
	import { ArrowRight, Check, RotateCcw, Send, ShieldCheck, Sparkles, X } from "@lucide/svelte";
	import { untrack } from "svelte";
	import type { ChatMessage, InboxNotification } from "./types";

	let {
		initialMessages,
		context,
		onClearContext,
	}: {
		initialMessages: ChatMessage[];
		context: InboxNotification | null;
		onClearContext: () => void;
	} = $props();

	let messages = $state(untrack(() => [...initialMessages]));
	let draft = $state("");
	let responding = $state(false);
	let connection = $state<"checking" | "connected" | "unavailable">("checking");

	$effect(() => {
		let cancelled = false;
		void fetch("/api/chat/status", { headers: { accept: "application/json" } })
			.then((response) => {
				if (!cancelled) connection = response.ok ? "connected" : "unavailable";
			})
			.catch(() => {
				if (!cancelled) connection = "unavailable";
			});
		return () => { cancelled = true; };
	});

	async function sendMessage() {
		const body = draft.trim();
		if (!body || responding) return;
		const createdAt = Date.now();
		const assistantId = `message_agent_${createdAt}`;
		messages.push({
			id: `message_user_${createdAt}`,
			role: "user",
			body,
			createdAt: "Now",
		});
		draft = "";
		messages.push({
			id: assistantId,
			role: "agent",
			body: "",
			createdAt: "Now",
		});
		responding = true;

		try {
			const response = await fetch("/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/x-ndjson" },
				body: JSON.stringify({
					message: body,
					...(context ? { context: { title: context.title, summary: context.summary } } : {}),
				}),
			});
			if (!response.ok || !response.body) throw new Error(await responseError(response));
			connection = "connected";

			const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += value;
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (line) applyStreamEvent(assistantId, line);
					newline = buffer.indexOf("\n");
				}
			}
		} catch (error) {
			connection = "unavailable";
			setAssistantText(assistantId, `I couldn’t connect to the local LifeOS agent. ${error instanceof Error ? error.message : "Please try again."}`);
		} finally {
			responding = false;
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void sendMessage();
		}
	}

	function applyStreamEvent(assistantId: string, line: string) {
		const event = JSON.parse(line) as { type?: string; delta?: string; error?: string };
		if (event.type === "delta" && event.delta) appendAssistantText(assistantId, event.delta);
		if (event.type === "error") throw new Error(event.error || "LifeOS could not complete this response.");
	}

	function appendAssistantText(messageId: string, delta: string) {
		messages = messages.map((message) =>
			message.id === messageId ? { ...message, body: `${message.body}${delta}` } : message,
		);
	}

	function setAssistantText(messageId: string, body: string) {
		messages = messages.map((message) => message.id === messageId ? { ...message, body } : message);
	}

	async function responseError(response: Response): Promise<string> {
		try {
			const value = await response.json() as { error?: string };
			return value.error || `LifeOS chat returned ${response.status}`;
		} catch {
			return `LifeOS chat returned ${response.status}`;
		}
	}

	function undoReceipt(messageId: string) {
		messages = messages.map((message) =>
			message.id === messageId && message.artifact
				? { ...message, artifact: { ...message.artifact, status: "undone" } }
				: message,
		);
	}

	function reviewProposal(message: ChatMessage) {
		if (!message.artifact) return;
		messages.push({
			id: `message_review_${Date.now()}`,
			role: "agent",
			body: `“${message.artifact.title}” is an external action. The connected version will open the exact recipient and reply for confirmation before anything is sent.`,
			createdAt: "Now",
		});
	}
</script>

<section class="flex min-h-0 flex-1 flex-col bg-muted/20" aria-labelledby="chat-heading">
	<div class="flex h-[81px] shrink-0 items-center justify-between border-b bg-background px-5 sm:px-6">
		<div class="flex items-center gap-3">
			<div class="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
				<Sparkles class="size-4" aria-hidden="true" />
			</div>
			<div>
				<h1 id="chat-heading" class="font-semibold">LifeOS</h1>
				<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
					<span class={`size-1.5 rounded-full ${connection === "connected" ? "bg-emerald-500" : connection === "unavailable" ? "bg-rose-500" : "bg-amber-500"}`}></span>
					{connection === "connected" ? "Connected through Codex" : connection === "unavailable" ? "Agent unavailable" : "Connecting…"}
				</div>
			</div>
		</div>
		<Badge variant="outline">Read only</Badge>
	</div>

	{#if context}
		<div class="flex items-center gap-3 border-b bg-background px-5 py-3 sm:px-6">
			<div class="min-w-0 flex-1">
				<p class="text-xs font-medium text-muted-foreground">Discussing</p>
				<p class="truncate text-sm font-medium">{context.title}</p>
			</div>
			<Button variant="ghost" size="icon-sm" onclick={onClearContext} aria-label="Clear notification context">
				<X aria-hidden="true" />
			</Button>
		</div>
	{/if}

	<ScrollArea class="min-h-0 flex-1">
		<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-6 sm:px-8 sm:py-8" aria-live="polite">
			{#each messages as message (message.id)}
				<div class="flex gap-3" class:flex-row-reverse={message.role === "user"}>
					<Avatar size="sm" class="mt-0.5">
						<AvatarFallback>{message.role === "agent" ? "L" : "You"}</AvatarFallback>
					</Avatar>
					<div class="max-w-[85%] space-y-3 sm:max-w-[75%]">
						<div
							class="rounded-2xl px-4 py-3 text-sm leading-6 shadow-xs"
							class:rounded-tr-sm={message.role === "user"}
							class:bg-primary={message.role === "user"}
							class:text-primary-foreground={message.role === "user"}
							class:rounded-tl-sm={message.role === "agent"}
							class:border={message.role === "agent"}
							class:bg-background={message.role === "agent"}
						>
							{message.body}
						</div>

						{#if message.artifact}
							<div class="overflow-hidden rounded-xl border bg-background shadow-xs">
								<div class="flex items-center justify-between gap-3 px-4 py-3">
									<div class="flex items-center gap-2">
										{#if message.artifact.type === "receipt"}
											<Check class="size-4 text-emerald-600" aria-hidden="true" />
											<span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Automatic · Reversible</span>
										{:else}
											<ShieldCheck class="size-4 text-amber-600" aria-hidden="true" />
											<span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">External action</span>
										{/if}
									</div>
									<Badge variant={message.artifact.type === "proposal" ? "default" : "secondary"}>
										{message.artifact.status === "needs_approval"
											? "Approval required"
											: message.artifact.status === "undone" ? "Undone" : "Completed"}
									</Badge>
								</div>
								<Separator />
								<div class="space-y-1 px-4 py-4">
									<p class="font-medium" class:line-through={message.artifact.status === "undone"}>{message.artifact.title}</p>
									<p class="text-sm text-muted-foreground">{message.artifact.detail}</p>
									{#if message.artifact.destination}
										<p class="pt-2 text-xs text-muted-foreground">Destination: {message.artifact.destination}</p>
									{/if}
								</div>
								<div class="flex justify-end border-t bg-muted/30 px-4 py-3">
									{#if message.artifact.type === "receipt"}
										<Button variant="outline" size="sm" disabled={message.artifact.status === "undone"} onclick={() => undoReceipt(message.id)}>
											<RotateCcw data-icon="inline-start" aria-hidden="true" />
											{message.artifact.status === "undone" ? "Undone" : "Undo"}
										</Button>
									{:else}
										<Button size="sm" onclick={() => reviewProposal(message)}>
											Review reply
											<ArrowRight data-icon="inline-end" aria-hidden="true" />
										</Button>
									{/if}
								</div>
							</div>
						{/if}

						<p class="px-1 text-xs text-muted-foreground" class:text-right={message.role === "user"}>{message.createdAt}</p>
					</div>
				</div>
			{/each}
		</div>
	</ScrollArea>

	<div class="border-t bg-background p-4 sm:px-6 sm:py-5">
		<form class="mx-auto max-w-3xl" onsubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
			<div class="rounded-xl border bg-background p-2 shadow-sm focus-within:ring-3 focus-within:ring-ring/20">
				<Textarea
					bind:value={draft}
					onkeydown={handleKeydown}
					placeholder={responding ? "LifeOS is responding…" : context ? `Ask about “${context.title}”…` : "Message LifeOS…"}
					aria-label="Message LifeOS"
					class="min-h-16 resize-none border-0 shadow-none focus-visible:ring-0"
				/>
				<div class="flex items-center justify-between gap-3 px-1 pb-1">
					<p class="text-xs text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
					<Button size="icon" type="submit" disabled={!draft.trim() || responding} aria-label="Send message">
						<Send aria-hidden="true" />
					</Button>
				</div>
			</div>
		</form>
	</div>
</section>
