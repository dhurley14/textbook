import { randomUUID } from "node:crypto";
import { db, now } from "./index";

/**
 * Anything the model produced or consumed, stored verbatim so the transcript can be replayed into
 * the next completion without lossy re-serialization.
 */
export type StoredMessage = Record<string, unknown> & { role: string };

export type Customer = {
  id: string;
  barber_id: string;
  phone: string;
  name: string | null;
};

export function getOrCreateCustomer(barberId: string, phone: string): Customer {
  const existing = db
    .prepare(`SELECT id, barber_id, phone, name FROM customers WHERE barber_id = ? AND phone = ?`)
    .get(barberId, phone) as Customer | undefined;
  if (existing) return existing;

  const id = randomUUID();
  const timestamp = now();
  db.prepare(
    `INSERT INTO customers (id, barber_id, phone, name, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)`
  ).run(id, barberId, phone, timestamp, timestamp);

  return { id, barber_id: barberId, phone, name: null };
}

/** The model learns the customer's name mid-conversation; keep it for future bookings. */
export function setCustomerName(customerId: string, name: string): void {
  db.prepare(`UPDATE customers SET name = ?, updated_at = ? WHERE id = ?`).run(name, now(), customerId);
}

export function appendMessages(customerId: string, payloads: StoredMessage[]): void {
  const insert = db.prepare(`INSERT INTO messages (customer_id, payload, created_at) VALUES (?, ?, ?)`);
  const tx = db.transaction((items: StoredMessage[]) => {
    for (const item of items) insert.run(customerId, JSON.stringify(item), now());
  });
  tx(payloads);
}

/** Most recent `limit` messages, oldest first, trimmed so it never starts on an orphaned tool result. */
export function getRecentMessages(customerId: string, limit = 40): StoredMessage[] {
  const rows = db
    .prepare(`SELECT payload FROM messages WHERE customer_id = ? ORDER BY id DESC LIMIT ?`)
    .all(customerId, limit) as { payload: string }[];

  const messages = rows.reverse().map((r) => JSON.parse(r.payload) as StoredMessage);

  // A `tool` message is only valid if the assistant turn that requested it is still in the window.
  let start = 0;
  while (start < messages.length && messages[start]!.role === "tool") start++;
  return messages.slice(start);
}
