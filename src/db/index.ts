import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "../config";

const dbPath = path.resolve(env.DATABASE_PATH);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  -- A tenant. One row per barber who signed up.
  CREATE TABLE IF NOT EXISTS barbers (
    id                      TEXT PRIMARY KEY,
    google_sub              TEXT NOT NULL UNIQUE,
    email                   TEXT NOT NULL,
    display_name            TEXT NOT NULL,
    avatar_url              TEXT,
    shop_name               TEXT NOT NULL,
    timezone                TEXT NOT NULL,
    business_hours          TEXT NOT NULL,
    appointment_duration_minutes INTEGER NOT NULL,
    slot_interval_minutes   INTEGER NOT NULL DEFAULT 15,
    min_lead_time_minutes   INTEGER NOT NULL DEFAULT 60,
    booking_window_days     INTEGER NOT NULL DEFAULT 14,
    notify_phone            TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  );

  -- Google OAuth grant. Separate from barbers so a revoked grant is an obvious, reparable state.
  CREATE TABLE IF NOT EXISTS google_accounts (
    barber_id               TEXT PRIMARY KEY REFERENCES barbers(id) ON DELETE CASCADE,
    calendar_id             TEXT NOT NULL,
    refresh_token_encrypted TEXT NOT NULL,
    access_token            TEXT,
    access_token_expires_at TEXT,
    scopes                  TEXT NOT NULL,
    -- Set when Google rejects the refresh token; the barber must reconnect.
    needs_reauth            INTEGER NOT NULL DEFAULT 0,
    updated_at              TEXT NOT NULL
  );

  -- Inbound routing: a customer's text arrives addressed To one of these.
  CREATE TABLE IF NOT EXISTS phone_numbers (
    id               TEXT PRIMARY KEY,
    barber_id        TEXT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    e164             TEXT NOT NULL UNIQUE,
    twilio_sid       TEXT NOT NULL UNIQUE,
    status           TEXT NOT NULL DEFAULT 'active',
    created_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_phone_numbers_barber ON phone_numbers (barber_id);

  -- The same person texting two different barbers is two rows; that is intentional.
  CREATE TABLE IF NOT EXISTS customers (
    id          TEXT PRIMARY KEY,
    barber_id   TEXT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    phone       TEXT NOT NULL,
    name        TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (barber_id, phone)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages (customer_id, id);

  CREATE TABLE IF NOT EXISTS appointments (
    id              TEXT PRIMARY KEY,
    barber_id       TEXT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    customer_id     TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    google_event_id TEXT NOT NULL,
    customer_name   TEXT NOT NULL,
    starts_at       TEXT NOT NULL,
    ends_at         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'booked',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (barber_id, google_event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_appointments_barber ON appointments (barber_id, starts_at);
  CREATE INDEX IF NOT EXISTS idx_appointments_customer ON appointments (customer_id, starts_at);

  -- Reserved for two-way rescheduling: incremental sync + watch channel bookkeeping.
  CREATE TABLE IF NOT EXISTS calendar_sync (
    barber_id            TEXT PRIMARY KEY REFERENCES barbers(id) ON DELETE CASCADE,
    sync_token           TEXT,
    channel_id           TEXT,
    resource_id          TEXT,
    channel_expires_at   TEXT,
    last_synced_at       TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    barber_id   TEXT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_barber ON sessions (barber_id);

  CREATE TABLE IF NOT EXISTS processed_sms (
    message_sid  TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL
  );
`);

export const now = () => new Date().toISOString();

/** Returns true the first time a Twilio MessageSid is seen; Twilio retries webhooks. */
export function claimSmsForProcessing(messageSid: string): boolean {
  const result = db
    .prepare(`INSERT OR IGNORE INTO processed_sms (message_sid, created_at) VALUES (?, ?)`)
    .run(messageSid, now());
  return result.changes === 1;
}
