import { OAuth2Client } from "google-auth-library";

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPayloadPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPayloadPart[];
}

export interface GmailApiMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  historyId?: string;
  payload?: GmailPayloadPart;
}

export interface GmailApiThread {
  id: string;
  historyId?: string;
  messages?: GmailApiMessage[];
}

export interface GmailSourceAdapter {
  listImportantMessageIds(input: { maxResults: number; pageToken?: string }): Promise<{
    messageIds: string[]; nextPageToken?: string;
  }>;
  getMessage(messageId: string): Promise<GmailApiMessage>;
  getThread(threadId: string): Promise<GmailApiThread>;
  getProfile(): Promise<{ emailAddress: string; historyId?: string }>;
}

export class GmailRestAdapter implements GmailSourceAdapter {
  private readonly auth: OAuth2Client;

  constructor(input: { clientId: string; clientSecret: string; refreshToken: string }) {
    this.auth = new OAuth2Client(input.clientId, input.clientSecret);
    this.auth.setCredentials({ refresh_token: input.refreshToken, scope: "https://www.googleapis.com/auth/gmail.readonly" });
  }

  async listImportantMessageIds(input: { maxResults: number; pageToken?: string }): Promise<{
    messageIds: string[]; nextPageToken?: string;
  }> {
    const parameters = new URLSearchParams({
      maxResults: String(Math.min(Math.max(input.maxResults, 1), 500)),
      includeSpamTrash: "false",
    });
    parameters.append("labelIds", "IMPORTANT");
    if (input.pageToken) parameters.set("pageToken", input.pageToken);
    const result = await this.request<{ messages?: Array<{ id?: string }>; nextPageToken?: string }>(`/users/me/messages?${parameters}`);
    const messageIds = (result.messages ?? []).flatMap((message) => message.id ? [message.id] : []);
    return { messageIds, ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}) };
  }

  getMessage(messageId: string): Promise<GmailApiMessage> {
    return this.request(`/users/me/messages/${encodeURIComponent(messageId)}?format=full`);
  }

  getThread(threadId: string): Promise<GmailApiThread> {
    return this.request(`/users/me/threads/${encodeURIComponent(threadId)}?format=full`);
  }

  getProfile(): Promise<{ emailAddress: string; historyId?: string }> {
    return this.request("/users/me/profile");
  }

  private async request<T>(path: string): Promise<T> {
    const token = await this.auth.getAccessToken();
    if (!token.token) throw new Error("Gmail OAuth did not return an access token");
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
      headers: { Authorization: `Bearer ${token.token}` },
    });
    if (!response.ok) throw new Error(`Gmail API request failed (${response.status})`);
    return response.json() as Promise<T>;
  }
}
