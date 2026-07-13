import { expect, test } from "bun:test";

import {
	disabledLifeOsTools, lifeOsMcpConfigurationArguments, lifeOsToolConfiguration,
	readOnlyLifeOsTools,
} from "../src/lib/server/codex/app-server";

const reviewedEnabledTools = [
	"life_os_doctor", "life_os_list_compact_state", "life_os_list_pending_proposals",
	"life_os_gmail_status", "life_os_calendar_status", "life_os_imessage_status",
	"life_os_telegram_status", "life_os_work_status", "life_os_review_email_extractions",
	"life_os_review_imessage_extractions", "life_os_get_proposal",
] as const;

const reviewedDisabledTools = [
	"life_os_rebuild_state", "life_os_get_morning_briefing", "life_os_ingest_calendar",
	"life_os_ingest_gmail", "life_os_ingest_imessage", "life_os_ingest_telegram",
	"life_os_propose_finding_task", "life_os_preview_email_extraction_context",
	"life_os_prepare_email_extraction", "life_os_submit_email_extraction",
	"life_os_preview_imessage_extraction_context", "life_os_prepare_imessage_extraction",
	"life_os_submit_imessage_extraction", "life_os_triage_imessage_service_messages",
	"life_os_prepare_proposal_approval", "life_os_apply_approved_proposal",
	"life_os_prepare_undo", "life_os_undo_action", "life_os_prepare_morning_reasoning",
	"life_os_submit_morning_reasoning",
] as const;

test("browser chat has an exact read-only LifeOS tool boundary", () => {
	expect(readOnlyLifeOsTools).toEqual(reviewedEnabledTools);
	expect(disabledLifeOsTools).toEqual(reviewedDisabledTools);
	expect(lifeOsToolConfiguration()).toEqual({
		enabled: reviewedEnabledTools, disabled: reviewedDisabledTools,
	});
	const args = lifeOsMcpConfigurationArguments("op", ["run", "life-os"]);
	expect(args).toContain(`mcp_servers.life-os.enabled_tools=${JSON.stringify(reviewedEnabledTools)}`);
	expect(args).toContain(`mcp_servers.life-os.disabled_tools=${JSON.stringify(reviewedDisabledTools)}`);
});
