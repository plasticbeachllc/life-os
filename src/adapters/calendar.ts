import { OAuth2Client } from "google-auth-library";

export interface CalendarApiEvent {
  id: string; status?: string; summary?: string; location?: string; updated?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
}

export interface CalendarSourceAdapter {
  getPrimaryCalendar(): Promise<{ id: string; timeZone?: string }>;
  listEvents(input: { calendarId: string; timeMin: string; timeMax: string; pageToken?: string }): Promise<{
    events: CalendarApiEvent[]; nextPageToken?: string;
  }>;
}

export class GoogleCalendarRestAdapter implements CalendarSourceAdapter {
  private readonly auth: OAuth2Client;
  constructor(input: { clientId: string; clientSecret: string; refreshToken: string }) {
    this.auth = new OAuth2Client(input.clientId, input.clientSecret);
    this.auth.setCredentials({ refresh_token: input.refreshToken });
  }
  getPrimaryCalendar(): Promise<{ id: string; timeZone?: string }> {
    return this.request("/calendars/primary");
  }
  async listEvents(input: { calendarId: string; timeMin: string; timeMax: string; pageToken?: string }): Promise<{
    events: CalendarApiEvent[]; nextPageToken?: string;
  }> {
    const query = new URLSearchParams({
      timeMin: input.timeMin, timeMax: input.timeMax, singleEvents: "true",
      orderBy: "startTime", showDeleted: "true", maxResults: "250",
    });
    if (input.pageToken) query.set("pageToken", input.pageToken);
    const result = await this.request<{ items?: CalendarApiEvent[]; nextPageToken?: string }>(
      `/calendars/${encodeURIComponent(input.calendarId)}/events?${query}`,
    );
    return { events: result.items ?? [], ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}) };
  }
  private async request<T>(path: string): Promise<T> {
    const token = await this.auth.getAccessToken();
    if (!token.token) throw new Error("Google OAuth did not return an access token");
    const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
      headers: { Authorization: `Bearer ${token.token}` },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as {
        error?: { message?: string; errors?: Array<{ reason?: string }> };
      } | undefined;
      const reason = body?.error?.errors?.[0]?.reason;
      const message = body?.error?.message;
      throw new Error(`Google Calendar API request failed (${response.status})${reason ? ` ${reason}` : ""}${message ? `: ${message}` : ""}`);
    }
    return response.json() as Promise<T>;
  }
}
