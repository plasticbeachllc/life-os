export type NotificationKind = "email" | "calendar" | "proposal" | "system" | "task";
export type NotificationCategory = "needs_you" | "activity" | "approvals";
export type NotificationTone = "question" | "receipt" | "proposal" | "update";
export type NotificationActionKind = "undo" | "resolve" | "review" | "discuss" | "dismiss";

export interface NotificationAction {
	kind: NotificationActionKind;
	label: string;
}

export interface InboxNotification {
	id: string;
	kind: NotificationKind;
	category: NotificationCategory;
	tone: NotificationTone;
	status: "open" | "resolved";
	title: string;
	summary: string;
	detail?: string;
	agentSummary?: { sentences: string[]; actionRequired: boolean };
	relativeTime: string;
	primaryAction?: NotificationAction;
	secondaryAction?: NotificationAction;
	feedbackSubjectKind?: "attention";
}

export interface ChatArtifact {
	type: "receipt" | "proposal";
	status: "completed" | "undone" | "needs_approval";
	title: string;
	detail: string;
	destination?: string;
}

export interface ChatMessage {
	id: string;
	role: "agent" | "user";
	body: string;
	createdAt: string;
	artifact?: ChatArtifact;
}

export interface WorkspaceSnapshot {
	mode: "loading" | "live" | "empty" | "stale" | "partial" | "failed" | "setup_required";
	generatedAt: string;
	sources: Array<{ provider: string; enabled: boolean; health: "healthy" | "disabled" | "partial" | "failed"; summary: string }>;
	attention: Array<{ category: "reply" | "open_loop" | "date" | "relationship" | "project"; count: number; freshness: string }>;
	findings: { total: number; active: number; byKind: Record<string, number>; items: Array<{ id: string; kind: string; status: string; dueDate: string | null }> };
	state: { projectionCount: number; freshness: string; provenance: string };
	proposals: Array<{ id: string; effectType: string; state: string; approval: "required" | "approved"; preview: string; createdAt: string; expiresAt: string | null }>;
	actions: Array<{ id: string; effectType: string; state: string; result: "succeeded" | "failed" | "unknown"; undo: "available" | "used" | "unavailable"; createdAt: string }>;
	work: { pending: number; leased: number; failed: number; oldestPendingAgeSeconds: number | null; failureCategories: Record<string, number> };
	message?: string;
}
