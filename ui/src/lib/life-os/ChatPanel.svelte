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

	type SummaryState = "none" | "pending" | "started";
	interface Conversation {
		id: string;
		title: string;
		createdAt: string;
		context: InboxNotification | null;
		messages: ChatMessage[];
		summaryState: SummaryState;
	}

	const homeConversation: Conversation = {
		id: "conversation_home",
		title: "New conversation",
		createdAt: "Started now",
		context: null,
		messages: untrack(() => [...initialMessages]),
		summaryState: "none",
	};
	let conversations = $state<Conversation[]>([homeConversation]);
	let activeConversationId = $state(homeConversation.id);
	let activeConversation = $derived(conversations.find((item) => item.id === activeConversationId) ?? homeConversation);
	let messages = $derived(activeConversation.messages);
	let activeContext = $derived(activeConversation.context);
	let draft = $state("");
	let respondingConversationId = $state<string | null>(null);
	let responding = $derived(respondingConversationId !== null);
	let connection = $state<"checking" | "connected" | "unavailable">("checking");
	const pendingText = "Summarizing…";
	let observedContextId: string | null | undefined;
	let conversationSequence = 0;

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

	$effect(() => {
		const incoming = context;
		const incomingId = incoming?.id ?? null;
		if (observedContextId === undefined) {
			observedContextId = incomingId;
			if (incoming) startConversation(incoming);
			return;
		}
		if (incomingId === observedContextId) return;
		observedContextId = incomingId;
		startConversation(incoming);
	});

	$effect(() => {
		const conversation = activeConversation;
		if (conversation.summaryState !== "pending" || responding) return;
		updateConversation(conversation.id, (current) => ({ ...current, summaryState: "started" }));
		void beginAgentTurn({
			intent: "summarize_context",
			notificationId: conversation.context!.id,
			context: contextPayload(conversation.context!),
		}, undefined, conversation.id);
	});

	async function sendMessage() {
		const body = draft.trim();
		if (!body || responding) return;
		draft = "";
		await beginAgentTurn({
			message: body,
			...(activeContext ? { context: contextPayload(activeContext) } : {}),
		}, body);
	}

	async function beginAgentTurn(
		request: Record<string, unknown>,
		userBody?: string,
		conversationId = activeConversationId,
	) {
		if (responding) return;
		const createdAt = Date.now();
		const assistantId = `message_agent_${createdAt}`;
		if (userBody) {
			appendMessage(conversationId, {
				id: `message_user_${createdAt}`,
				role: "user",
				body: userBody,
				createdAt: "Now",
			});
		}
		appendMessage(conversationId, {
			id: assistantId,
			role: "agent",
			body: pendingText,
			createdAt: "Now",
		});
		respondingConversationId = conversationId;

		try {
			const response = await fetch("/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/x-ndjson" },
				body: JSON.stringify({ ...request, conversationId }),
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
					if (line) applyStreamEvent(conversationId, assistantId, line);
					newline = buffer.indexOf("\n");
				}
			}
		} catch (error) {
			connection = "unavailable";
			setAssistantText(conversationId, assistantId, `I couldn’t connect to the local LifeOS agent. ${error instanceof Error ? error.message : "Please try again."}`);
		} finally {
			if (respondingConversationId === conversationId) respondingConversationId = null;
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void sendMessage();
		}
	}

	function applyStreamEvent(conversationId: string, assistantId: string, line: string) {
		const event = JSON.parse(line) as { type?: string; delta?: string; text?: string; index?: number; error?: string };
		if (event.type === "message" && event.text) {
			const current = conversations.find((item) => item.id === conversationId)?.messages
				.find((message) => message.id === assistantId);
			if (current?.body === pendingText) setAssistantText(conversationId, assistantId, event.text);
			else appendMessage(conversationId, {
				id: `${assistantId}_sentence_${event.index ?? 0}`,
				role: "agent",
				body: event.text,
				createdAt: "Now",
			});
			updateConversation(conversationId, (conversation) => ({
				...conversation,
				context: conversation.context ? {
					...conversation.context,
					agentSummary: {
						sentences: [...(conversation.context.agentSummary?.sentences ?? []), event.text!].slice(0, 3),
						actionRequired: conversation.context.agentSummary?.actionRequired
							?? conversation.context.category !== "activity",
					},
				} : null,
			}));
		}
		if (event.type === "delta" && event.delta) {
			const current = conversations.find((item) => item.id === conversationId)?.messages
				.find((message) => message.id === assistantId);
			if (current?.body === pendingText) setAssistantText(conversationId, assistantId, event.delta);
			else appendAssistantText(conversationId, assistantId, event.delta);
		}
		if (event.type === "error") throw new Error(event.error || "LifeOS could not complete this response.");
	}

	function appendAssistantText(conversationId: string, messageId: string, delta: string) {
		updateMessages(conversationId, (message) =>
			message.id === messageId ? { ...message, body: `${message.body}${delta}` } : message);
	}

	function setAssistantText(conversationId: string, messageId: string, body: string) {
		updateMessages(conversationId, (message) => message.id === messageId ? { ...message, body } : message);
	}

	async function responseError(response: Response): Promise<string> {
		try {
			const value = await response.json() as { error?: string };
			return value.error || `LifeOS chat returned ${response.status}`;
		} catch {
			return `LifeOS chat returned ${response.status}`;
		}
	}

	function contextPayload(notification: InboxNotification) {
		return { kind: notification.kind, category: notification.category,
			title: notification.title, summary: notification.summary,
			...(notification.detail ? { detail: notification.detail } : {}),
			...(notification.primaryAction ? { suggestedAction: notification.primaryAction.label } : {}),
			...(notification.agentSummary ? { agentSummary: notification.agentSummary.sentences } : {}) };
	}

	function startConversation(selected: InboxNotification | null) {
		conversationSequence += 1;
		const now = new Date();
		const conversation: Conversation = {
			id: `conversation_${now.getTime()}_${conversationSequence}`,
			title: selected?.title ?? "New conversation",
			createdAt: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
			context: selected ? { ...selected } : null,
			messages: selected?.agentSummary
				? selected.agentSummary.sentences.map((sentence, index) => ({
					id: `message_cached_${now.getTime()}_${index}`,
					role: "agent" as const,
					body: sentence,
					createdAt: "Cached",
				}))
				: selected ? [] : [...initialMessages],
			summaryState: selected?.agentSummary ? "none" : selected ? "pending" : "none",
		};
		conversations = [conversation, ...conversations];
		activeConversationId = conversation.id;
		draft = "";
	}

	function selectConversation(event: Event) {
		activeConversationId = (event.currentTarget as HTMLSelectElement).value;
		draft = "";
	}

	function clearActiveContext() {
		if (context) onClearContext();
		else startConversation(null);
	}

	function updateConversation(id: string, updater: (conversation: Conversation) => Conversation) {
		conversations = conversations.map((conversation) => conversation.id === id ? updater(conversation) : conversation);
	}

	function appendMessage(conversationId: string, message: ChatMessage) {
		updateConversation(conversationId, (conversation) => ({
			...conversation,
			messages: [...conversation.messages, message],
		}));
	}

	function updateMessages(conversationId: string, updater: (message: ChatMessage) => ChatMessage) {
		updateConversation(conversationId, (conversation) => ({
			...conversation,
			messages: conversation.messages.map(updater),
		}));
	}

	function undoReceipt(messageId: string) {
		updateMessages(activeConversationId, (message) =>
			message.id === messageId && message.artifact
				? { ...message, artifact: { ...message.artifact, status: "undone" } }
				: message);
	}

	function reviewProposal(message: ChatMessage) {
		if (!message.artifact) return;
		appendMessage(activeConversationId, {
			id: `message_review_${Date.now()}`,
			role: "agent",
			body: `“${message.artifact.title}” would affect the outside world. Review the exact recipient and content before approving it; nothing has been sent.`,
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
			<div class="min-w-0">
				<h1 id="chat-heading" class="sr-only">LifeOS conversations</h1>
				<select
					class="block max-w-52 cursor-pointer truncate border-0 bg-transparent p-0 pr-6 text-sm font-semibold outline-none sm:max-w-72"
					value={activeConversationId}
					onchange={selectConversation}
					aria-label="Conversation history"
				>
					{#each conversations as conversation (conversation.id)}
						<option value={conversation.id}>{conversation.title} · {conversation.createdAt}</option>
					{/each}
				</select>
				<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
					<span class={`size-1.5 rounded-full ${connection === "connected" ? "bg-emerald-500" : connection === "unavailable" ? "bg-rose-500" : "bg-amber-500"}`}></span>
					{connection === "connected" ? "Connected through Codex" : connection === "unavailable" ? "Agent unavailable" : "Connecting…"}
				</div>
			</div>
		</div>
		<Badge variant="outline">Read only</Badge>
	</div>

	{#if activeContext}
		<div class="flex items-center gap-3 border-b bg-background px-5 py-3 sm:px-6">
			<div class="min-w-0 flex-1">
				<p class="text-xs font-medium text-muted-foreground">Discussing</p>
				<p class="truncate text-sm font-medium">{activeContext.title}</p>
			</div>
			<Button variant="ghost" size="icon-sm" onclick={clearActiveContext} aria-label="Clear notification context">
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
							class="whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 shadow-xs"
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
					placeholder={responding ? "LifeOS is responding…" : activeContext ? `Ask about “${activeContext.title}”…` : "Message LifeOS…"}
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
