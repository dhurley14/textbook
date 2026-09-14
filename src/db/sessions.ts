import { randomBytes } from "node:crypto";
import { db, now } from "./index";

const SESSION_DAYS = 30;

/**
 * Opaque 256-bit session ids stored server-side. No signing needed: the id *is* the secret, and
 * revocation is a DELETE.
 */
export function createSession(barberId: string): { id: string; expiresAt: Date } {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  db.prepare(`INSERT INTO sessions (id, barber_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(
    id,
    barberId,
    now(),
    expiresAt.toISOString()
  );

  return { id, expiresAt };
}

export function getSessionBarberId(sessionId: string): string | null {
  const row = db
    .prepare(`SELECT barber_id, expires_at FROM sessions WHERE id = ?`)
    .get(sessionId) as { barber_id: string; expires_at: string } | undefined;

  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    deleteSession(sessionId);
    return null;
  }
  return row.barber_id;
}

export function deleteSession(sessionId: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}
