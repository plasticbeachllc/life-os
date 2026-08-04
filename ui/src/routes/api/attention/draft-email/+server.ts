import { json } from "@sveltejs/kit";

import { parseBrowserActionRequest, requireBrowserActionSubject } from "$lib/server/action-request";
import { draftEmailFromAttention } from "$lib/server/email-drafts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies, url }) => {
  try {
    const value = await parseBrowserActionRequest({
      request, url, keys: ["attentionUiId", "csrfToken"],
    });
    requireBrowserActionSubject({
      cookies, csrfToken: value.csrfToken!,
      subjectUiId: value.attentionUiId!, subjectKind: "attention",
    });
    return json(await draftEmailFromAttention(value.attentionUiId!), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return json({ error: "The email draft could not be prepared. Refresh the source and try again." }, {
      status: 400, headers: { "cache-control": "no-store" },
    });
  }
};
