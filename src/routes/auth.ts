import { randomBytes } from "node:crypto";
import { Router } from "express";
import { buildConsentUrl, exchangeCode, hasCalendarScope } from "../auth/google";
import { consumeOAuthState, endSession, setOAuthState, startSession } from "../auth/session";
import { createBarber, findBarberByGoogleSub } from "../db/barbers";
import { getGoogleAccount, upsertGoogleAccount } from "../db/google";

export const authRouter = Router();

authRouter.get("/auth/google", (_req, res) => {
  const state = randomBytes(16).toString("base64url");
  setOAuthState(res, state);
  res.redirect(buildConsentUrl(state));
});

authRouter.get("/auth/google/callback", async (req, res) => {
  const expectedState = consumeOAuthState(req, res);
  const { code, state, error } = req.query as Record<string, string | undefined>;

  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect("/?error=missing_code");
  if (!state || !expectedState || state !== expectedState) return res.redirect("/?error=bad_state");

  try {
    const result = await exchangeCode(code);

    if (!hasCalendarScope(result.scopes)) {
      return res.redirect("/?error=calendar_scope_required");
    }

    const barber =
      findBarberByGoogleSub(result.identity.sub) ??
      createBarber({
        googleSub: result.identity.sub,
        email: result.identity.email,
        displayName: result.identity.name,
        avatarUrl: result.identity.picture,
      });

    // Google omits the refresh token when re-consenting an existing grant; keep the stored one.
    const refreshToken = result.refreshToken ?? getGoogleAccount(barber.id)?.refreshToken ?? null;
    if (!refreshToken) {
      return res.redirect("/?error=no_refresh_token");
    }

    upsertGoogleAccount({
      barberId: barber.id,
      // The barber's own calendar, since they authorized as themselves.
      calendarId: "primary",
      refreshToken,
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
      scopes: result.scopes,
    });

    startSession(res, barber.id);
    res.redirect("/dashboard");
  } catch (callbackError) {
    console.error("[auth] Google callback failed", callbackError);
    res.redirect("/?error=auth_failed");
  }
});

authRouter.post("/auth/logout", (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});
