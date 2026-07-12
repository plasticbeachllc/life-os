import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "../../src/db/store";
import { compileUiNotifications, shouldSurfaceClarification } from "../../src/ui/notifications";

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
			title: "LifeOS noticed a risk",
			summary: "One active project has no next action.",
			category: "for_you",
		}));
		expect(serialized).not.toContain("state_private_identifier");
		expect(serialized).not.toContain("project_private_identifier");
		expect(serialized).not.toContain("private-source-hash");
	});
});
