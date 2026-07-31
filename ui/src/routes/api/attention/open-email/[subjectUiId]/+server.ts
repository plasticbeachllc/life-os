import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { currentChatSession } from "$lib/server/chat-session";
import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, cookies }) => {
  if (!currentChatSession(cookies) || !/^ui_[a-f0-9]{20}$/.test(params.subjectUiId)) {
    return new Response("Not found", { status: 404 });
  }
  const root = repositoryRoot();
  const [{ loadConfig }, { OperationalStore }, { compileAttentionReview },
    { attentionSubjectUiId }, { gmailThreadUrlForAttention }] = await Promise.all([
    import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/config.ts")).href),
    import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/db/store.ts")).href),
    import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/attention/review.ts")).href),
    import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/ui/feedback.ts")).href),
    import(/* @vite-ignore */ pathToFileURL(resolve(root, "src/ui/attention-source.ts")).href),
  ]);
  const store = new OperationalStore(loadConfig().databasePath);
  const state = store.getCurrentDerivedState("finding_attention_state");
  if (!state) return new Response("Not found", { status: 404 });
  const item = compileAttentionReview(state).items.find((candidate: {
    attentionId: string;
    presentation: { channel: "review_queue"; reason: string; policyVersion: string };
  }) => attentionSubjectUiId({
    attentionId: candidate.attentionId,
    presentationChannel: candidate.presentation.channel,
    presentationReason: candidate.presentation.reason,
    policyVersion: candidate.presentation.policyVersion,
  }) === params.subjectUiId);
  if (!item) return new Response("Not found", { status: 404 });
  const destination = gmailThreadUrlForAttention(store, item);
  if (!destination) return new Response("Email is no longer available", { status: 404 });
  redirect(303, destination);
};

function repositoryRoot(): string {
  const configured = process.env.LIFE_OS_REPO_PATH;
  if (configured) return resolve(configured);
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, "src/db/schema.ts"))) return cwd;
  if (existsSync(resolve(cwd, "../src/db/schema.ts"))) return resolve(cwd, "..");
  throw new Error("LifeOS repository root was not found; set LIFE_OS_REPO_PATH");
}
