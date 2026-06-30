import { randomUUID } from "crypto";
import { google } from "googleapis";
import { env } from "../../config/env";

export type CreateMeetLinkInput = {
  summary?: string;
  startTime?: Date;
  durationMinutes?: number;
};

export type MeetLinkResult = {
  url: string;
  // External calendar event id (when created via Google), useful for later
  // lookups/cleanup. Absent for placeholder links.
  externalId?: string;
  // True when the link is a non-functional dev/unconfigured fallback.
  isPlaceholder: boolean;
};

// Scope needed to create calendar events that carry a Google Meet conference.
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

/**
 * Mints Google Meet links centrally, using a single platform-owned Google
 * Workspace service account (credentials from env). All firms share it — there
 * is no per-firm Google connection. When credentials are absent (e.g. local
 * dev without a Workspace seat) a clearly-marked placeholder link is returned
 * so the consultation flow never hard-fails.
 */
export class GoogleMeetService {
  isConfigured(): boolean {
    return Boolean(
      env.GOOGLE_MEET_CLIENT_EMAIL &&
        env.GOOGLE_MEET_PRIVATE_KEY &&
        env.GOOGLE_MEET_IMPERSONATED_USER,
    );
  }

  async createMeetLink(
    input: CreateMeetLinkInput = {},
  ): Promise<MeetLinkResult> {
    if (!this.isConfigured()) {
      return this.placeholder();
    }

    try {
      const auth = new google.auth.JWT({
        email: env.GOOGLE_MEET_CLIENT_EMAIL,
        // Private keys are commonly stored with escaped newlines in env files.
        key: env.GOOGLE_MEET_PRIVATE_KEY!.replace(/\\n/g, "\n"),
        scopes: CALENDAR_SCOPES,
        subject: env.GOOGLE_MEET_IMPERSONATED_USER,
      });

      const calendar = google.calendar({ version: "v3", auth });

      const start = input.startTime ?? new Date();
      const end = new Date(
        start.getTime() + (input.durationMinutes ?? 30) * 60_000,
      );

      const { data } = await calendar.events.insert({
        calendarId: "primary",
        conferenceDataVersion: 1,
        requestBody: {
          summary: input.summary ?? "Consultation",
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
          conferenceData: {
            createRequest: {
              requestId: randomUUID(),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        },
      });

      const url =
        data.hangoutLink ??
        data.conferenceData?.entryPoints?.find(
          (entry) => entry.entryPointType === "video",
        )?.uri ??
        undefined;

      if (!url) {
        console.error(
          "[google-meet] event created but no Meet link was returned",
        );
        return this.placeholder();
      }

      return { url, externalId: data.id ?? undefined, isPlaceholder: false };
    } catch (error) {
      console.error("[google-meet] failed to create Meet link", error);
      return this.placeholder();
    }
  }

  private placeholder(): MeetLinkResult {
    const id = randomUUID().replace(/-/g, "").slice(0, 10);
    return {
      url: `https://meet.google.com/lookup/${id}`,
      isPlaceholder: true,
    };
  }
}

export const googleMeetService = new GoogleMeetService();
