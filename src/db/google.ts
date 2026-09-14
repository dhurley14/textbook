import { db, now } from "./index";
import { decrypt, encrypt } from "../auth/crypto";

export type GoogleAccountRow = {
  barber_id: string;
  calendar_id: string;
  refresh_token_encrypted: string;
  access_token: string | null;
  access_token_expires_at: string | null;
  scopes: string;
  needs_reauth: number;
  updated_at: string;
};

export type GoogleAccount = {
  barberId: string;
  calendarId: string;
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  scopes: string[];
  needsReauth: boolean;
};

function hydrate(row: GoogleAccountRow): GoogleAccount {
  return {
    barberId: row.barber_id,
    calendarId: row.calendar_id,
    refreshToken: decrypt(row.refresh_token_encrypted),
    accessToken: row.access_token,
    accessTokenExpiresAt: row.access_token_expires_at,
    scopes: row.scopes.split(" ").filter(Boolean),
    needsReauth: row.needs_reauth === 1,
  };
}

export function getGoogleAccount(barberId: string): GoogleAccount | null {
  const row = db.prepare(`SELECT * FROM google_accounts WHERE barber_id = ?`).get(barberId) as
    | GoogleAccountRow
    | undefined;
  return row ? hydrate(row) : null;
}

export function hasGoogleAccount(barberId: string): boolean {
  const row = db.prepare(`SELECT needs_reauth FROM google_accounts WHERE barber_id = ?`).get(barberId) as
    | { needs_reauth: number }
    | undefined;
  return row !== undefined && row.needs_reauth === 0;
}

export function upsertGoogleAccount(input: {
  barberId: string;
  calendarId: string;
  refreshToken: string;
  accessToken?: string | null;
  accessTokenExpiresAt?: string | null;
  scopes: string[];
}): void {
  db.prepare(
    `INSERT INTO google_accounts (
       barber_id, calendar_id, refresh_token_encrypted, access_token, access_token_expires_at,
       scopes, needs_reauth, updated_at
     ) VALUES (@barberId, @calendarId, @refreshToken, @accessToken, @expiresAt, @scopes, 0, @updatedAt)
     ON CONFLICT(barber_id) DO UPDATE SET
       calendar_id = excluded.calendar_id,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       access_token = excluded.access_token,
       access_token_expires_at = excluded.access_token_expires_at,
       scopes = excluded.scopes,
       needs_reauth = 0,
       updated_at = excluded.updated_at`
  ).run({
    barberId: input.barberId,
    calendarId: input.calendarId,
    refreshToken: encrypt(input.refreshToken),
    accessToken: input.accessToken ?? null,
    expiresAt: input.accessTokenExpiresAt ?? null,
    scopes: input.scopes.join(" "),
    updatedAt: now(),
  });
}

/** Cache the short-lived access token so every message doesn't cost a token refresh round-trip. */
export function saveAccessToken(barberId: string, accessToken: string, expiresAt: string): void {
  db.prepare(
    `UPDATE google_accounts SET access_token = ?, access_token_expires_at = ?, updated_at = ?
     WHERE barber_id = ?`
  ).run(accessToken, expiresAt, now(), barberId);
}

/**
 * Google rejected the refresh token — revoked, password-changed, or six months idle. The barber has
 * to reconnect; booking stays broken until they do, so surface it rather than retrying forever.
 */
export function markNeedsReauth(barberId: string): void {
  db.prepare(`UPDATE google_accounts SET needs_reauth = 1, updated_at = ? WHERE barber_id = ?`).run(
    now(),
    barberId
  );
}

export function deleteGoogleAccount(barberId: string): void {
  db.prepare(`DELETE FROM google_accounts WHERE barber_id = ?`).run(barberId);
}
