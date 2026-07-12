export type NotificationKind = "email" | "calendar" | "proposal" | "system" | "task";
export type NotificationCategory = "for_you" | "activity" | "approvals";
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
	relativeTime: string;
	primaryAction?: NotificationAction;
	secondaryAction?: NotificationAction;
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
