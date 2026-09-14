import assert from "node:assert/strict";
import test from "node:test";
import { DateTime, Interval } from "luxon";
import { candidateSlots, isWithinBusinessHours, parseBusinessHours, removeBusy } from "./availability";

const ZONE = "America/New_York";
const hours = parseBusinessHours("1:09:00-12:00,2:09:00-17:00");
const options = { hours, durationMinutes: 45, intervalMinutes: 15 };

// Monday Sep 14 2026 through Tuesday Sep 15 2026.
const monday = DateTime.fromISO("2026-09-14T00:00:00", { zone: ZONE });
const mondayWindow = { from: monday, to: monday.endOf("day") };

test("slots stay inside business hours and fit the full appointment", () => {
  const slots = candidateSlots(mondayWindow, options);

  assert.equal(slots[0]!.start!.toFormat("HH:mm"), "09:00");
  assert.equal(slots.at(-1)!.end!.toFormat("HH:mm"), "12:00");
  assert.ok(slots.every((s) => s.length("minutes") === 45));
});

test("closed days produce no slots", () => {
  const sunday = monday.minus({ days: 1 });
  assert.equal(candidateSlots({ from: sunday, to: sunday.endOf("day") }, options).length, 0);
});

test("time-of-day filters narrow the results", () => {
  const tuesday = monday.plus({ days: 1 });
  const afternoon = candidateSlots(
    { from: tuesday, to: tuesday.endOf("day") },
    { ...options, earliestMinutes: 13 * 60 }
  );

  assert.ok(afternoon.length > 0);
  assert.ok(afternoon.every((s) => s.start!.hour >= 13));
});

test("busy calendar entries remove every overlapping slot", () => {
  const slots = candidateSlots(mondayWindow, options);
  const busy = [
    Interval.fromDateTimes(
      DateTime.fromISO("2026-09-14T09:30:00", { zone: ZONE }),
      DateTime.fromISO("2026-09-14T10:30:00", { zone: ZONE })
    ),
  ];

  const free = removeBusy(slots, busy);

  assert.ok(free.every((s) => !s.overlaps(busy[0]!)));
  assert.ok(free.some((s) => s.start!.toFormat("HH:mm") === "10:30"));
  assert.ok(!free.some((s) => s.start!.toFormat("HH:mm") === "09:00"));
});

test("an appointment that runs past closing is rejected", () => {
  const closing = DateTime.fromISO("2026-09-14T11:30:00", { zone: ZONE });
  assert.equal(isWithinBusinessHours(closing, 45, hours), false);
  assert.equal(isWithinBusinessHours(closing.minus({ minutes: 30 }), 45, hours), true);
});

test("malformed business hours are rejected loudly", () => {
  assert.throws(() => parseBusinessHours("1:9-17"));
  assert.throws(() => parseBusinessHours("1:17:00-09:00"));
  assert.throws(() => parseBusinessHours(""));
});
