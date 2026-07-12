import { randomBytes } from "node:crypto";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";

import { GmailRestAdapter } from "../adapters/gmail";
import type { GmailCredentialStore } from "../gmail/keychain";

const gmailReadonlyScope = "https://www.googleapis.com/auth/gmail.readonly";
const calendarReadonlyScope = "https://www.googleapis.com/auth/calendar.readonly";

export async function authorizeGmailDesktop(input: {
  clientId: string;
  clientSecret: string;
  accountId: string;
  credentialStore: GmailCredentialStore;
  openBrowser?: (url: string) => void;
  timeoutMs?: number;
}): Promise<{ emailAddress: string; scope: string; storedIn: "macOS Keychain" }> {
  const state = randomBytes(24).toString("hex");
  let resolveCallback!: (value: { code: string; state: string }) => void;
  let rejectCallback!: (error: Error) => void;
  const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/oauth2/callback") return new Response("Not found", { status: 404 });
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      if (error) {
        rejectCallback(new Error(`Google OAuth authorization failed: ${error}`));
        return htmlResponse("Authorization was not granted. Return to the terminal.", 400);
      }
      if (!code || !returnedState) {
        rejectCallback(new Error("Google OAuth callback omitted code or state"));
        return htmlResponse("Authorization response was incomplete. Return to the terminal.", 400);
      }
      resolveCallback({ code, state: returnedState });
      return htmlResponse("Life OS Google read-only authorization succeeded. You can close this tab.");
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}/oauth2/callback`;
  const client = new OAuth2Client(input.clientId, input.clientSecret, redirectUri);
  const verifier = await client.generateCodeVerifierAsync();
  if (!verifier.codeChallenge) throw new Error("Google OAuth PKCE challenge generation failed");
  const authorizationUrl = client.generateAuthUrl({
    access_type: "offline", prompt: "consent", scope: [gmailReadonlyScope, calendarReadonlyScope], state,
    code_challenge: verifier.codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });
  const openBrowser = input.openBrowser ?? ((url: string) => {
    Bun.spawn(["/usr/bin/open", url], { stdout: "ignore", stderr: "ignore" });
  });
  openBrowser(authorizationUrl);
  const timeout = setTimeout(() => rejectCallback(new Error("Gmail OAuth authorization timed out")), input.timeoutMs ?? 180_000);
  try {
    const authorization = await callback;
    if (authorization.state !== state) throw new Error("Google OAuth state mismatch");
    const tokens = await client.getToken({ code: authorization.code, codeVerifier: verifier.codeVerifier, redirect_uri: redirectUri });
    const refreshToken = tokens.tokens.refresh_token;
    if (!refreshToken) throw new Error("Google did not return a refresh token; revoke prior consent and retry");
    const adapter = new GmailRestAdapter({
      clientId: input.clientId, clientSecret: input.clientSecret, refreshToken,
    });
    const profile = await adapter.getProfile();
    input.credentialStore.setRefreshToken(input.accountId, refreshToken);
    return { emailAddress: profile.emailAddress, scope: `${gmailReadonlyScope} ${calendarReadonlyScope}`, storedIn: "macOS Keychain" };
  } finally {
    clearTimeout(timeout);
    server.stop(true);
  }
}

function htmlResponse(message: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Life OS Gmail</title><p>${message}</p>`, {
    status, headers: { "content-type": "text/html; charset=utf-8" },
  });
}
