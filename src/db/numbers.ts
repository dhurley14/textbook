import { randomUUID } from "node:crypto";
import { db, now } from "./index";

export type PhoneNumberRow = {
  id: string;
  barber_id: string;
  e164: string;
  twilio_sid: string;
  status: string;
  created_at: string;
};

export function getNumberForBarber(barberId: string): PhoneNumberRow | null {
  return (
    (db
      .prepare(`SELECT * FROM phone_numbers WHERE barber_id = ? AND status = 'active'`)
      .get(barberId) as PhoneNumberRow | undefined) ?? null
  );
}

export function recordNumber(input: { barberId: string; e164: string; twilioSid: string }): PhoneNumberRow {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO phone_numbers (id, barber_id, e164, twilio_sid, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`
  ).run(id, input.barberId, input.e164, input.twilioSid, now());

  return getNumberForBarber(input.barberId)!;
}

export function releaseNumber(barberId: string): void {
  db.prepare(`UPDATE phone_numbers SET status = 'released' WHERE barber_id = ?`).run(barberId);
}
