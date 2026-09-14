import { google, calendar_v3 } from "googleapis";
import { createOAuthClient } from "../auth/google";
import { getGoogleAccount, markNeedsReauth, saveAccessToken } from "../db/google";

/** Raised when a barber's Google grant is gone and only they can fix it by reconnecting. */
export class ReauthRequiredError extends Error {
  constructor(public readonly barberId: string) {
    super("This barber's Google Calendar connection needs to be reauthorized");
    this.name = "ReauthRequiredError";
  }
}

export class CalendarNotConnectedError extends Error {
  constructor(public readonly barberId: string) {
    super("This barber has not connected a Google Calendar yet");
    this.name = "CalendarNotConnectedError";
  }
}

function isInvalidGrant(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const response = (error as { response?: { data?: { error?: string } } }).response;
  return response?.data?.error === "invalid_grant" || message.includes("invalid_grant");
}

export type TenantCalendar = {
  calendarId: string;
  api: calendar_v3.Calendar;
};

/**
 * Builds a Calendar client bound to one barber's grant. The googleapis client refreshes the access
 * token on demand; we cache the result so a burst of texts doesn't refresh on every message.
 */
export function getCalendarForBarber(barberId: string): TenantCalendar {
  const account = getGoogleAccount(barberId);
  if (!account) throw new CalendarNotConnectedError(barberId);
  if (account.needsReauth) throw new ReauthRequiredError(barberId);

  const auth = createOAuthClient();
  auth.setCredentials({
    refresh_token: account.refreshToken,
    access_token: account.accessToken ?? undefined,
    expiry_date: account.accessTokenExpiresAt ? new Date(account.accessTokenExpiresAt).getTime() : undefined,
  });

  auth.on("tokens", (tokens) => {
    if (tokens.access_token && tokens.expiry_date) {
      saveAccessToken(barberId, tokens.access_token, new Date(tokens.expiry_date).toISOString());
    }
  });

  return { calendarId: account.calendarId, api: google.calendar({ version: "v3", auth }) };
}

/**
 * Runs a calendar call, converting a dead refresh token into a durable "needs reauth" flag instead
 * of an error that repeats on every inbound text.
 */
export async function withCalendar<T>(
  barberId: string,
  fn: (calendar: TenantCalendar) => Promise<T>
): Promise<T> {
  const calendar = getCalendarForBarber(barberId);
  try {
    return await fn(calendar);
  } catch (error) {
    if (isInvalidGrant(error)) {
      markNeedsReauth(barberId);
      throw new ReauthRequiredError(barberId);
    }
    throw error;
  }
}
