import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../../src/db/store";
import { GmailStore } from "../../src/gmail/store";
import {
	compileUiNotificationBundle,
	compileUiNotifications,
	UI_NOTIFICATION_SUMMARY_MODEL,
	UI_NOTIFICATION_SUMMARY_POLICY_VERSION,
	UI_NOTIFICATION_SUMMARY_PROMPT_VERSION,
	UI_NOTIFICATION_SUMMARY_SCHEMA_VERSION,
	shouldSurfaceClarification,
} from "../../src/ui/notifications";

let temporaryDirectory: string | undefined;

afterEach(() => {
	if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
	temporaryDirectory = undefined;
});

describe("LifeOS notification compiler", () => {
	test("surfaces only extraction-level ambiguity as clarification", () => {
		expect(shouldSurfaceClarification({
			classification: "actionable",
			unresolved: ["A non-blocking detail remains uncertain."],
		})).toBe(false);
		expect(shouldSurfaceClarification({
			classification: "ambiguous",
			unresolved: ["The ambiguity blocks a reliable action."],
		})).toBe(true);
	});

	test("projects compact state into sanitized UI notifications", () => {
		temporaryDirectory = mkdtempSync(join(tmpdir(), "life-os-ui-notifications-"));
		const databasePath = join(temporaryDirectory, "life-os.db");
		const store = new OperationalStore(databasePath);
		store.migrate();
		store.saveDerivedState({
			stateId: "state_private_identifier",
			stateType: "chief_of_staff_state",
			stateVersion: 1,
			content: {
				active_risks: [{ summary: "One active project has no next action.", entity_ids: ["project_private_identifier"] }],
			},
			sourceHashes: ["sha256:private-source-hash"],
			generationMethod: "test",
			createdAt: "2026-07-12T12:00:00.000Z",
		});

		Bun.env.LIFE_OS_VAULT_PATH = temporaryDirectory;
		Bun.env.LIFE_OS_DATABASE_PATH = databasePath;
		Bun.env.LIFE_OS_GMAIL_ENABLED = "false";
		Bun.env.LIFE_OS_CALENDAR_ENABLED = "false";

		const snapshot = compileUiNotifications(new Date("2026-07-12T13:00:00.000Z"));
		const serialized = JSON.stringify(snapshot);

		expect(snapshot.mode).toBe("live");
		expect(snapshot.notifications).toContainEqual(expect.objectContaining({
			title: "Something may need attention",
			summary: "One active project has no next action.",
			category: "needs_you",
		}));
		expect(serialized).not.toContain("state_private_identifier");
		expect(serialized).not.toContain("project_private_identifier");
		expect(serialized).not.toContain("private-source-hash");

		const firstBundle = compileUiNotificationBundle(new Date("2026-07-12T13:00:00.000Z"));
		const secondBundle = compileUiNotificationBundle(new Date("2026-07-12T13:05:00.000Z"));
		const firstCandidate = firstBundle.summaryCandidates.find((candidate) =>
			candidate.notificationId === snapshot.notifications[0]?.id);
		const secondCandidate = secondBundle.summaryCandidates.find((candidate) =>
			candidate.notificationId === snapshot.notifications[0]?.id);
		expect(firstCandidate?.cacheKey).toBe(secondCandidate?.cacheKey);
		expect(firstCandidate?.manifest.contextHash).toBe(secondCandidate?.manifest.contextHash);
		expect(store.countRows("model_calls")).toBe(0);

		store.putModelCache({
			cacheKey: firstCandidate!.cacheKey,
			workflow: "ui-notification-summary",
			promptVersion: UI_NOTIFICATION_SUMMARY_PROMPT_VERSION,
			model: UI_NOTIFICATION_SUMMARY_MODEL,
			sourceHash: firstCandidate!.sourceHash,
			contextHash: firstCandidate!.manifest.contextHash,
			schemaVersion: UI_NOTIFICATION_SUMMARY_SCHEMA_VERSION,
			policyVersion: UI_NOTIFICATION_SUMMARY_POLICY_VERSION,
			output: { sentences: ["Grounded cached reaction.", "Review the underlying risk."], actionRequired: true },
			createdAt: "2026-07-12T13:00:00.000Z",
		});
		const cached = compileUiNotifications(new Date("2026-07-12T13:10:00.000Z"));
		expect(cached.notifications[0]?.agentSummary).toEqual({
			sentences: ["Grounded cached reaction.", "Review the underlying risk."],
			actionRequired: true,
		});
	});

	test("keeps background extraction backlog out of the notification feed", () => {
		temporaryDirectory = mkdtempSync(join(tmpdir(), "life-os-ui-backlog-"));
		const databasePath = join(temporaryDirectory, "life-os.db");
		const store = new OperationalStore(databasePath);
		store.migrate();
		new GmailStore(store).upsertAccount({
			accountId: "me",
			emailAddress: "owner@example.com",
			selectionLabelId: "IMPORTANT_OR_SENT",
			now: "2026-07-12T12:00:00.000Z",
		});
		const db = store.open();
		try {
			db.query(`INSERT INTO gmail_messages (
				account_id, message_id, thread_id, internal_date, from_address,
				to_addresses_json, cc_addresses_json, subject, rfc_message_id,
				selected_important, content_hash, current_version_hash, ingestion_state,
				first_ingested_at, last_ingested_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'ingested', ?, ?)`)
				.run(
					"me", "message-1", "thread-1", "1", null, "[]", "[]", null, null,
					"sha256:content", "sha256:content",
					"2026-07-12T12:00:00.000Z", "2026-07-12T12:00:00.000Z",
				);
		} finally {
			db.close();
		}

		Bun.env.LIFE_OS_VAULT_PATH = temporaryDirectory;
		Bun.env.LIFE_OS_DATABASE_PATH = databasePath;
		Bun.env.LIFE_OS_GMAIL_ENABLED = "true";
		Bun.env.LIFE_OS_GMAIL_ACCOUNT_ID = "me";
		Bun.env.LIFE_OS_CALENDAR_ENABLED = "false";

		const snapshot = compileUiNotifications(new Date("2026-07-12T13:00:00.000Z"));

		expect(snapshot.notifications.some((notification) =>
			notification.title.includes("important email")
			|| notification.summary.includes("structured extraction"),
		)).toBe(false);
	});

	test("surfaces only routed review-queue attention through opaque UI identities", () => {
		temporaryDirectory = mkdtempSync(join(tmpdir(), "life-os-ui-attention-"));
		const databasePath = join(temporaryDirectory, "life-os.db");
		const store = new OperationalStore(databasePath);
		store.migrate();
		store.saveDerivedState({
			stateId: "state_private_attention", stateType: "finding_attention_state", stateVersion: 4,
			content: {
				as_of: "2026-07-12T12:00:00.000Z",
				signals: [{
					attention_id: "attention_private_review", type: "untracked_user_commitment",
					title: "Commitment is not tracked", summary: "Prepare the planning notes",
					finding_ids: ["finding_private"], subject_refs: [], owner: "user",
					confidence: 0.95, impact: "medium", urgency: "soon", due_date: null,
					explanation: "No matching canonical task exists.", ambiguities: [],
					suggested_interventions: [{ kind: "create_task", rationale: "Track it.",
						expected_benefit: "Include it in planning.", consequence_of_delay: null,
						permission_class: "yellow", readiness: "ready", reversible: true }],
				}],
				presentation: [{ attention_id: "attention_private_review", channel: "review_queue",
					reason: "reviewable_intervention", explanation: "A bounded review is useful.",
					policy_version: "attention-presentation-v1" }],
			},
			sourceHashes: ["sha256:private"], generationMethod: "test",
			createdAt: "2026-07-12T12:00:00.000Z",
		});

		Bun.env.LIFE_OS_VAULT_PATH = temporaryDirectory;
		Bun.env.LIFE_OS_DATABASE_PATH = databasePath;
		Bun.env.LIFE_OS_GMAIL_ENABLED = "false";
		Bun.env.LIFE_OS_CALENDAR_ENABLED = "false";

		const snapshot = compileUiNotifications(new Date("2026-07-12T13:00:00.000Z"));
		const notification = snapshot.notifications.find((item) => item.feedbackSubjectKind === "attention");
		const serialized = JSON.stringify(snapshot);
		expect(notification).toMatchObject({
			kind: "task", category: "needs_you", title: "Commitment is not tracked",
			feedbackSubjectKind: "attention", primaryAction: { label: "Review next step" },
			secondaryAction: { label: "Not relevant" },
		});
		expect(notification?.id).toMatch(/^ui_[a-f0-9]{20}$/);
		expect(serialized).not.toMatch(/attention_private_review|finding_private|state_private_attention|sha256:/);
	});
});
