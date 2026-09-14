import type { NextFunction, Request, Response } from "express";
import { env } from "../config";
import { findBarberById, type Barber } from "../db/barbers";
import { createSession, deleteSession, getSessionBarberId } from "../db/sessions";

const COOKIE_NAME = "tb_session";
const STATE_COOKIE = "tb_oauth_state";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      barber?: Barber;
      sessionId?: string;
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((part) => {
      const index = part.indexOf("=");
      if (index === -1) return [part.trim(), ""];
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    })
  );
}

function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    // Lax rather than Strict: the OAuth callback is a cross-site top-level navigation back from
    // Google, and Strict would drop the cookie on that hop.
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeMs,
  };
}

export function startSession(res: Response, barberId: string): void {
  const session = createSession(barberId);
  res.cookie(COOKIE_NAME, session.id, cookieOptions(session.expiresAt.getTime() - Date.now()));
}

export function endSession(req: Request, res: Response): void {
  const sessionId = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (sessionId) deleteSession(sessionId);
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

/** Attaches req.barber when a valid session cookie is present. Never rejects. */
export function loadSession(req: Request, _res: Response, next: NextFunction): void {
  const sessionId = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!sessionId) return next();

  const barberId = getSessionBarberId(sessionId);
  if (!barberId) return next();

  const barber = findBarberById(barberId);
  if (barber) {
    req.barber = barber;
    req.sessionId = sessionId;
  }
  next();
}

export function requireBarber(req: Request, res: Response, next: NextFunction): void {
  if (!req.barber) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  next();
}

/** CSRF protection for the OAuth round-trip: the state must come back matching the cookie. */
export function setOAuthState(res: Response, state: string): void {
  res.cookie(STATE_COOKIE, state, cookieOptions(10 * 60 * 1000));
}

export function consumeOAuthState(req: Request, res: Response): string | null {
  const state = parseCookies(req.headers.cookie)[STATE_COOKIE] ?? null;
  res.clearCookie(STATE_COOKIE, { path: "/" });
  return state;
}
