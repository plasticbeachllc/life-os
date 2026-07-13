import { expect, test } from "bun:test";

import { disabledLifeOsTools, readOnlyLifeOsTools } from "../src/lib/server/codex/app-server";

test("browser chat has an exact read-only LifeOS tool boundary", () => {
	const enabled = new Set<string>(readOnlyLifeOsTools);
	const disabled = new Set<string>(disabledLifeOsTools);
	expect(new Set(readOnlyLifeOsTools).size).toBe(readOnlyLifeOsTools.length);
	expect(readOnlyLifeOsTools.every((name) =>
		/status|review|list|get_proposal|doctor|work_status/.test(name))).toBe(true);
	for (const mutation of [
		"life_os_prepare_proposal_approval", "life_os_apply_approved_proposal",
		"life_os_prepare_undo", "life_os_undo_action", "life_os_propose_finding_task",
	]) {
		expect(enabled.has(mutation)).toBe(false);
		expect(disabled.has(mutation)).toBe(true);
	}
});
