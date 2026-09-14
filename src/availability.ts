import { DateTime, Interval } from "luxon";

export type HoursRange = { startMinutes: number; endMinutes: number };

/** dayOfWeek (0=Sunday..6=Saturday) -> open ranges, expressed as minutes from midnight. */
export type WeeklyHours = Map<number, HoursRange[]>;

function parseClock(value: string, raw: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Business hours entry "${raw}" has an invalid time "${value}" (expected HH:MM)`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Business hours entry "${raw}" has an out-of-range time "${value}"`);
  return hours * 60 + minutes;
}

/** Parses the BUSINESS_HOURS format: "1:09:00-17:00,6:10:00-16:00" (0=Sunday..6=Saturday). */
export function parseBusinessHours(spec: string): WeeklyHours {
  const hours: WeeklyHours = new Map();

  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const match = /^(\d):(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(raw);
    if (!match) {
      throw new Error(`Business hours entry "${raw}" is malformed (expected "dayOfWeek:HH:MM-HH:MM")`);
    }
    const day = Number(match[1]);
    const startMinutes = parseClock(match[2]!, raw);
    const endMinutes = parseClock(match[3]!, raw);
    if (endMinutes <= startMinutes) {
      throw new Error(`Business hours entry "${raw}" ends before it starts (overnight hours are not supported)`);
    }
    hours.set(day, [...(hours.get(day) ?? []), { startMinutes, endMinutes }]);
  }

  if (hours.size === 0) throw new Error("Business hours must define at least one open day");
  return hours;
}

export type SlotWindow = { from: DateTime; to: DateTime };

export type SlotOptions = {
  hours: WeeklyHours;
  durationMinutes: number;
  intervalMinutes: number;
  /** Shop-local minutes-from-midnight bounds on the slot's start time. */
  earliestMinutes?: number | null;
  latestMinutes?: number | null;
};

/** Every appointment-length window that fits inside business hours, ignoring the calendar. */
export function candidateSlots(window: SlotWindow, options: SlotOptions): Interval[] {
  const slots: Interval[] = [];
  const duration = { minutes: options.durationMinutes };

  let day = window.from.startOf("day");
  while (day <= window.to) {
    // luxon weekday is 1=Monday..7=Sunday; business hours are keyed 0=Sunday..6=Saturday.
    for (const range of options.hours.get(day.weekday % 7) ?? []) {
      const open = day.plus({ minutes: range.startMinutes });
      const close = day.plus({ minutes: range.endMinutes });

      let cursor = open;
      while (cursor.plus(duration) <= close) {
        const slot = Interval.fromDateTimes(cursor, cursor.plus(duration));
        const minutesOfDay = cursor.hour * 60 + cursor.minute;
        const afterEarliest = options.earliestMinutes == null || minutesOfDay >= options.earliestMinutes;
        const beforeLatest = options.latestMinutes == null || minutesOfDay <= options.latestMinutes;

        if (afterEarliest && beforeLatest && slot.start! >= window.from && slot.end! <= window.to) {
          slots.push(slot);
        }
        cursor = cursor.plus({ minutes: options.intervalMinutes });
      }
    }
    day = day.plus({ days: 1 });
  }

  return slots;
}

export function removeBusy(slots: Interval[], busy: Interval[]): Interval[] {
  return slots.filter((slot) => !busy.some((b) => b.overlaps(slot)));
}

export function isWithinBusinessHours(
  start: DateTime,
  durationMinutes: number,
  hours: WeeklyHours
): boolean {
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = startMinutes + durationMinutes;
  return (hours.get(start.weekday % 7) ?? []).some(
    (r) => startMinutes >= r.startMinutes && endMinutes <= r.endMinutes
  );
}
