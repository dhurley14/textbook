import { google } from "googleapis";
import { env, googleRedirectUri } from "../config";

/**
 * Identity plus calendar access in one consent screen, so a barber approves once at signup.
 * `calendar` (not `calendar.events`) is needed because free/busy lookups read the whole calendar.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar",
];

export function createOAuthClient() {
  return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, googleRedirectUri);
}

export function buildConsentUrl(state: string): string {
  return createOAuthClient().generateAuthUrl({
    access_type: "offline",
    // Without this, a barber who already granted access gets no refresh token on reconnect.
    prompt: "consent",
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state,
  });
}

export type GoogleIdentity = {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
};

export type ConsentResult = {
  identity: GoogleIdentity;
  refreshToken: string | null;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  scopes: string[];
};

export async function exchangeCode(code: string): Promise<ConsentResult> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.id_token) throw new Error("Google did not return an id_token");
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();

  if (!payload?.sub || !payload.email) {
    throw new Error("Google id_token is missing the account identifier or email");
  }

  return {
    identity: {
      sub: payload.sub,
      email: payload.email,
      name: payload.name ?? payload.email,
      picture: payload.picture ?? null,
    },
    refreshToken: tokens.refresh_token ?? null,
    accessToken: tokens.access_token ?? null,
    accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    scopes: (tokens.scope ?? "").split(" ").filter(Boolean),
  };
}

export function hasCalendarScope(scopes: string[]): boolean {
  return scopes.some((s) => s === "https://www.googleapis.com/auth/calendar");
}
