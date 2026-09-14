import { randomUUID } from "node:crypto";
import { db, now } from "./index";

export type AppointmentRow = {
  id: string;
  barber_id: string;
  customer_id: string;
  google_event_id: string;
  customer_name: string;
  starts_at: string;
  ends_at: string;
  status: string;
};

export type AppointmentWithCustomer = AppointmentRow & { customer_phone: string };

export function recordAppointment(input: {
  barberId: string;
  customerId: string;
  googleEventId: string;
  customerName: string;
  startsAt: string;
  endsAt: string;
}): string {
  const id = randomUUID();
  const timestamp = now();

  db.prepare(
    `INSERT INTO appointments (
       id, barber_id, customer_id, google_event_id, customer_name, starts_at, ends_at,
       status, created_at, updated_at
     ) VALUES (@id, @barberId, @customerId, @googleEventId, @customerName, @startsAt, @endsAt,
       'booked', @timestamp, @timestamp)
     ON CONFLICT(barber_id, google_event_id) DO NOTHING`
  ).run({ ...input, id, timestamp });

  return id;
}

export function getUpcomingForCustomer(customerId: string): AppointmentRow[] {
  return db
    .prepare(
      `SELECT * FROM appointments
       WHERE customer_id = ? AND status = 'booked' AND starts_at >= ?
       ORDER BY starts_at ASC`
    )
    .all(customerId, now()) as AppointmentRow[];
}

/** Dashboard view: the barber's whole book, with the number to text if plans change. */
export function getUpcomingForBarber(barberId: string, limit = 100): AppointmentWithCustomer[] {
  return db
    .prepare(
      `SELECT a.*, c.phone AS customer_phone
       FROM appointments a
       JOIN customers c ON c.id = a.customer_id
       WHERE a.barber_id = ? AND a.status = 'booked' AND a.starts_at >= ?
       ORDER BY a.starts_at ASC
       LIMIT ?`
    )
    .all(barberId, now(), limit) as AppointmentWithCustomer[];
}

export function markCancelled(barberId: string, googleEventId: string): void {
  db.prepare(
    `UPDATE appointments SET status = 'cancelled', updated_at = ?
     WHERE barber_id = ? AND google_event_id = ?`
  ).run(now(), barberId, googleEventId);
}
