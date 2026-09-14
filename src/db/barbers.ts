import { randomUUID } from "node:crypto";
import { db, now } from "./index";
import { env } from "../config";
import { parseBusinessHours, type WeeklyHours } from "../availability";

export type BarberRow = {
  id: string;
  google_sub: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  shop_name: string;
  timezone: string;
  business_hours: string;
  appointment_duration_minutes: number;
  slot_interval_minutes: number;
  min_lead_time_minutes: number;
  booking_window_days: number;
  notify_phone: string | null;
  created_at: string;
  updated_at: string;
};

/** A barber plus the derived values the booking code actually wants. */
export type Barber = BarberRow & { hours: WeeklyHours };

function hydrate(row: BarberRow): Barber {
  return { ...row, hours: parseBusinessHours(row.business_hours) };
}

export function findBarberById(id: string): Barber | null {
  const row = db.prepare(`SELECT * FROM barbers WHERE id = ?`).get(id) as BarberRow | undefined;
  return row ? hydrate(row) : null;
}

export function findBarberByGoogleSub(sub: string): Barber | null {
  const row = db.prepare(`SELECT * FROM barbers WHERE google_sub = ?`).get(sub) as BarberRow | undefined;
  return row ? hydrate(row) : null;
}

/** Resolves the tenant for an inbound text from the number it was addressed to. */
export function findBarberByPhoneNumber(e164: string): Barber | null {
  const row = db
    .prepare(
      `SELECT b.* FROM barbers b
       JOIN phone_numbers p ON p.barber_id = b.id
       WHERE p.e164 = ? AND p.status = 'active'`
    )
    .get(e164) as BarberRow | undefined;
  return row ? hydrate(row) : null;
}

export function createBarber(input: {
  googleSub: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
}): Barber {
  const id = randomUUID();
  const timestamp = now();

  db.prepare(
    `INSERT INTO barbers (
       id, google_sub, email, display_name, avatar_url, shop_name, timezone, business_hours,
       appointment_duration_minutes, created_at, updated_at
     ) VALUES (@id, @googleSub, @email, @displayName, @avatarUrl, @shopName, @timezone, @businessHours,
       @duration, @timestamp, @timestamp)`
  ).run({
    id,
    googleSub: input.googleSub,
    email: input.email,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl ?? null,
    shopName: `${input.displayName.split(" ")[0] ?? input.displayName}'s Shop`,
    timezone: env.DEFAULT_TIMEZONE,
    businessHours: env.DEFAULT_BUSINESS_HOURS,
    duration: env.DEFAULT_APPOINTMENT_DURATION_MINUTES,
    timestamp,
  });

  return findBarberById(id)!;
}

export type BarberSettings = {
  shopName: string;
  displayName: string;
  timezone: string;
  businessHours: string;
  appointmentDurationMinutes: number;
  slotIntervalMinutes: number;
  minLeadTimeMinutes: number;
  bookingWindowDays: number;
  notifyPhone: string | null;
};

export function updateBarberSettings(id: string, settings: BarberSettings): Barber {
  // Reject malformed hours before they reach a customer conversation.
  parseBusinessHours(settings.businessHours);

  db.prepare(
    `UPDATE barbers SET
       shop_name = @shopName,
       display_name = @displayName,
       timezone = @timezone,
       business_hours = @businessHours,
       appointment_duration_minutes = @appointmentDurationMinutes,
       slot_interval_minutes = @slotIntervalMinutes,
       min_lead_time_minutes = @minLeadTimeMinutes,
       booking_window_days = @bookingWindowDays,
       notify_phone = @notifyPhone,
       updated_at = @updatedAt
     WHERE id = @id`
  ).run({ ...settings, id, updatedAt: now() });

  return findBarberById(id)!;
}
