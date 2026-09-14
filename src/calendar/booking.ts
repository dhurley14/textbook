import { calendar_v3 } from "googleapis";
import { DateTime, Interval } from "luxon";
import { candidateSlots, isWithinBusinessHours, removeBusy } from "../availability";
import type { Barber } from "../db/barbers";
import { withCalendar, type TenantCalendar } from "./client";

export type Slot = {
  /** ISO 8601 with offset, e.g. 2026-09-15T09:30:00-04:00 */
  start: string;
  end: string;
  /** Shop-local human label, e.g. "Mon Sep 15 at 9:30 AM" */
  label: string;
};

function label(dt: DateTime): string {
  return dt.toFormat("ccc LLL d 'at' h:mm a");
}

export function formatSlotLabel(iso: string, timezone: string): string {
  return label(DateTime.fromISO(iso, { zone: timezone }).setZone(timezone));
}

async function getBusyIntervals(
  calendar: TenantCalendar,
  timezone: string,
  from: DateTime,
  to: DateTime
): Promise<Interval[]> {
  const response = await calendar.api.freebusy.query({
    requestBody: {
      timeMin: from.toISO()!,
      timeMax: to.toISO()!,
      timeZone: timezone,
      items: [{ id: calendar.calendarId }],
    },
  });

  const calendars = response.data.calendars ?? {};
  const entry = calendars[calendar.calendarId] ?? Object.values(calendars)[0];

  if (entry?.errors?.length) {
    throw new Error(
      `Google Calendar free/busy lookup failed for "${calendar.calendarId}": ${entry.errors
        .map((e) => e.reason)
        .join(", ")}`
    );
  }

  return (entry?.busy ?? [])
    .filter((b): b is { start: string; end: string } => Boolean(b.start && b.end))
    .map((b) => Interval.fromDateTimes(DateTime.fromISO(b.start), DateTime.fromISO(b.end)))
    .filter((i) => i.isValid);
}

export type AvailabilityQuery = {
  /** Shop-local date (YYYY-MM-DD) to start searching from. Defaults to today. */
  fromDate?: string;
  /** Shop-local date (YYYY-MM-DD) to stop searching at, inclusive. */
  toDate?: string;
  /** Only return slots starting at or after this shop-local time (HH:MM). */
  earliestTime?: string;
  /** Only return slots starting at or before this shop-local time (HH:MM). */
  latestTime?: string;
  maxResults?: number;
};

function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export async function findAvailableSlots(barber: Barber, query: AvailabilityQuery = {}): Promise<Slot[]> {
  const zone = barber.timezone;
  const now = DateTime.now().setZone(zone);
  const windowEnd = now.plus({ days: barber.booking_window_days }).endOf("day");
  const earliestBookable = now.plus({ minutes: barber.min_lead_time_minutes });

  let from = query.fromDate ? DateTime.fromISO(query.fromDate, { zone }).startOf("day") : now.startOf("day");
  if (!from.isValid) throw new Error(`Invalid fromDate "${query.fromDate}" (expected YYYY-MM-DD)`);
  if (from < earliestBookable) from = earliestBookable;

  let to = query.toDate ? DateTime.fromISO(query.toDate, { zone }).endOf("day") : from.plus({ days: 7 }).endOf("day");
  if (!to.isValid) throw new Error(`Invalid toDate "${query.toDate}" (expected YYYY-MM-DD)`);
  if (to > windowEnd) to = windowEnd;

  if (to <= from) return [];

  const maxResults = Math.min(query.maxResults ?? 6, 20);
  const slots = candidateSlots(
    { from, to },
    {
      hours: barber.hours,
      durationMinutes: barber.appointment_duration_minutes,
      intervalMinutes: barber.slot_interval_minutes,
      earliestMinutes: query.earliestTime ? parseClock(query.earliestTime) : null,
      latestMinutes: query.latestTime ? parseClock(query.latestTime) : null,
    }
  );

  if (slots.length === 0) return [];

  const busy = await withCalendar(barber.id, (calendar) => getBusyIntervals(calendar, zone, from, to));

  return removeBusy(slots, busy)
    .slice(0, maxResults)
    .map((slot) => {
      const start = slot.start!.setZone(zone);
      return { start: start.toISO()!, end: slot.end!.setZone(zone).toISO()!, label: label(start) };
    });
}

export type BookingRequest = {
  startIso: string;
  customerName: string;
  customerPhone: string;
  notes?: string;
};

export type BookingResult =
  | { ok: true; eventId: string; start: string; end: string; label: string; htmlLink: string | null }
  | { ok: false; reason: "invalid_time" | "outside_hours" | "too_soon" | "taken"; message: string };

export async function bookAppointment(barber: Barber, request: BookingRequest): Promise<BookingResult> {
  const zone = barber.timezone;
  const start = DateTime.fromISO(request.startIso, { zone }).setZone(zone);

  if (!start.isValid) {
    return { ok: false, reason: "invalid_time", message: `"${request.startIso}" is not a valid date-time.` };
  }

  const end = start.plus({ minutes: barber.appointment_duration_minutes });
  const now = DateTime.now().setZone(zone);

  if (start < now.plus({ minutes: barber.min_lead_time_minutes })) {
    return {
      ok: false,
      reason: "too_soon",
      message: `Appointments need at least ${barber.min_lead_time_minutes} minutes of notice.`,
    };
  }
  if (start > now.plus({ days: barber.booking_window_days })) {
    return {
      ok: false,
      reason: "invalid_time",
      message: `Bookings are only open ${barber.booking_window_days} days ahead.`,
    };
  }
  if (!isWithinBusinessHours(start, barber.appointment_duration_minutes, barber.hours)) {
    return { ok: false, reason: "outside_hours", message: `${label(start)} is outside shop hours.` };
  }

  return withCalendar(barber.id, async (calendar) => {
    // Re-check immediately before writing so two texters can't claim the same slot.
    const busy = await getBusyIntervals(calendar, zone, start, end);
    if (busy.some((b) => b.overlaps(Interval.fromDateTimes(start, end)))) {
      return { ok: false as const, reason: "taken" as const, message: `${label(start)} was just taken.` };
    }

    const event: calendar_v3.Schema$Event = {
      summary: `Haircut — ${request.customerName}`,
      description: [
        `Booked by SMS from ${request.customerPhone}.`,
        request.notes ? `Notes: ${request.notes}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      start: { dateTime: start.toISO()!, timeZone: zone },
      end: { dateTime: end.toISO()!, timeZone: zone },
      extendedProperties: {
        private: { source: "textbook", barberId: barber.id, customerPhone: request.customerPhone },
      },
    };

    const created = await calendar.api.events.insert({ calendarId: calendar.calendarId, requestBody: event });
    if (!created.data.id) throw new Error("Google Calendar accepted the event but returned no id");

    return {
      ok: true as const,
      eventId: created.data.id,
      start: start.toISO()!,
      end: end.toISO()!,
      label: label(start),
      htmlLink: created.data.htmlLink ?? null,
    };
  });
}

export async function cancelAppointment(barber: Barber, eventId: string): Promise<void> {
  await withCalendar(barber.id, (calendar) =>
    calendar.api.events.delete({ calendarId: calendar.calendarId, eventId })
  );
}

export type CalendarStatus = {
  calendarId: string;
  summary: string;
  timeZone: string | null;
};

/** Used by the dashboard to show which calendar a barber is connected to. */
export async function getCalendarStatus(barber: Barber): Promise<CalendarStatus> {
  return withCalendar(barber.id, async (calendar) => {
    const entry = await calendar.api.calendars.get({ calendarId: calendar.calendarId });
    return {
      calendarId: calendar.calendarId,
      summary: entry.data.summary ?? calendar.calendarId,
      timeZone: entry.data.timeZone ?? null,
    };
  });
}
