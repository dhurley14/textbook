import { Router } from "express";
import { z } from "zod";
import { requireBarber } from "../auth/session";
import { updateBarberSettings } from "../db/barbers";
import { getGoogleAccount } from "../db/google";
import { getNumberForBarber } from "../db/numbers";
import { getUpcomingForBarber } from "../db/appointments";
import { getCalendarStatus } from "../calendar/booking";
import { CalendarNotConnectedError, ReauthRequiredError } from "../calendar/client";
import { activateNumberForBarber, deactivateNumberForBarber, ProvisioningError } from "../provisioning";
import { parseBusinessHours } from "../availability";

export const apiRouter = Router();

apiRouter.use("/api", requireBarber);

apiRouter.get("/api/me", async (req, res) => {
  const barber = req.barber!;
  const account = getGoogleAccount(barber.id);
  const number = getNumberForBarber(barber.id);

  let calendar: { summary: string; timeZone: string | null } | null = null;
  if (account && !account.needsReauth) {
    try {
      const status = await getCalendarStatus(barber);
      calendar = { summary: status.summary, timeZone: status.timeZone };
    } catch (error) {
      if (!(error instanceof ReauthRequiredError) && !(error instanceof CalendarNotConnectedError)) throw error;
    }
  }

  res.json({
    barber: {
      id: barber.id,
      email: barber.email,
      displayName: barber.display_name,
      avatarUrl: barber.avatar_url,
      shopName: barber.shop_name,
      timezone: barber.timezone,
      businessHours: barber.business_hours,
      appointmentDurationMinutes: barber.appointment_duration_minutes,
      slotIntervalMinutes: barber.slot_interval_minutes,
      minLeadTimeMinutes: barber.min_lead_time_minutes,
      bookingWindowDays: barber.booking_window_days,
      notifyPhone: barber.notify_phone,
    },
    google: {
      connected: Boolean(account),
      needsReauth: account?.needsReauth ?? false,
      calendar,
    },
    phoneNumber: number ? { e164: number.e164, createdAt: number.created_at } : null,
  });
});

apiRouter.get("/api/appointments", (req, res) => {
  const appointments = getUpcomingForBarber(req.barber!.id).map((a) => ({
    id: a.id,
    customerName: a.customer_name,
    customerPhone: a.customer_phone,
    startsAt: a.starts_at,
    endsAt: a.ends_at,
  }));
  res.json({ appointments });
});

const settingsSchema = z.object({
  shopName: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(80),
  timezone: z.string().trim().min(1),
  businessHours: z.string().trim().min(1),
  appointmentDurationMinutes: z.number().int().min(5).max(480),
  slotIntervalMinutes: z.number().int().min(5).max(240),
  minLeadTimeMinutes: z.number().int().min(0).max(10080),
  bookingWindowDays: z.number().int().min(1).max(90),
  notifyPhone: z.string().trim().max(20).nullable(),
});

apiRouter.put("/api/settings", (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid settings" });
    return;
  }

  try {
    parseBusinessHours(parsed.data.businessHours);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }

  if (!Intl.supportedValuesOf("timeZone").includes(parsed.data.timezone)) {
    res.status(400).json({ error: `"${parsed.data.timezone}" is not a recognized IANA timezone` });
    return;
  }

  const barber = updateBarberSettings(req.barber!.id, {
    ...parsed.data,
    notifyPhone: parsed.data.notifyPhone || null,
  });
  res.json({ ok: true, shopName: barber.shop_name });
});

apiRouter.get("/api/timezones", (_req, res) => {
  res.json({ timezones: Intl.supportedValuesOf("timeZone") });
});

const activateSchema = z.object({ areaCode: z.string().regex(/^\d{3}$/).optional() });

apiRouter.post("/api/phone-number", async (req, res) => {
  const parsed = activateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Area code must be 3 digits" });
    return;
  }

  try {
    const number = await activateNumberForBarber(req.barber!, parsed.data.areaCode);
    res.json({ phoneNumber: { e164: number.e164, createdAt: number.created_at } });
  } catch (error) {
    if (error instanceof ProvisioningError) {
      res.status(409).json({ error: error.message, code: error.code });
      return;
    }
    console.error("[api] number activation failed", error);
    res.status(502).json({ error: "Could not provision a number right now. Try again shortly." });
  }
});

apiRouter.delete("/api/phone-number", async (req, res) => {
  try {
    await deactivateNumberForBarber(req.barber!);
    res.json({ ok: true });
  } catch (error) {
    console.error("[api] number release failed", error);
    res.status(502).json({ error: "Could not release the number right now." });
  }
});
