import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

const tempDir = path.join(os.tmpdir(), `textbook-test-${randomUUID()}`);

// config reads process.env at import time, so the environment has to exist before any dynamic
// import below pulls it in.
Object.assign(process.env, {
  NODE_ENV: "test",
  APP_URL: "https://test.example.com",
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "testtoken",
  OPENAI_API_KEY: "sk-test",
  GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "secret",
  ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  DATABASE_PATH: path.join(tempDir, "test.sqlite"),
});

type Modules = {
  barbers: typeof import("./db/barbers");
  numbers: typeof import("./db/numbers");
  conversations: typeof import("./db/conversations");
  google: typeof import("./db/google");
  crypto: typeof import("./auth/crypto");
};

let m: Modules;

before(async () => {
  m = {
    barbers: await import("./db/barbers"),
    numbers: await import("./db/numbers"),
    conversations: await import("./db/conversations"),
    google: await import("./db/google"),
    crypto: await import("./auth/crypto"),
  };
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeBarber(name: string) {
  return m.barbers.createBarber({
    googleSub: `sub-${randomUUID()}`,
    email: `${name}@example.com`,
    displayName: name,
  });
}

test("an inbound number resolves to the barber who owns it", () => {
  const alice = makeBarber("Alice");
  const bob = makeBarber("Bob");

  m.numbers.recordNumber({ barberId: alice.id, e164: "+15550000001", twilioSid: `PN${randomUUID()}` });
  m.numbers.recordNumber({ barberId: bob.id, e164: "+15550000002", twilioSid: `PN${randomUUID()}` });

  assert.equal(m.barbers.findBarberByPhoneNumber("+15550000001")?.id, alice.id);
  assert.equal(m.barbers.findBarberByPhoneNumber("+15550000002")?.id, bob.id);
  assert.equal(m.barbers.findBarberByPhoneNumber("+15559999999"), null);
});

test("a released number stops routing to its former owner", () => {
  const barber = makeBarber("Carol");
  m.numbers.recordNumber({ barberId: barber.id, e164: "+15550000003", twilioSid: `PN${randomUUID()}` });
  assert.equal(m.barbers.findBarberByPhoneNumber("+15550000003")?.id, barber.id);

  m.numbers.releaseNumber(barber.id);
  assert.equal(m.barbers.findBarberByPhoneNumber("+15550000003"), null);
});

test("the same customer texting two barbers gets separate records and transcripts", () => {
  const alice = makeBarber("Alice2");
  const bob = makeBarber("Bob2");
  const phone = "+15551230000";

  const withAlice = m.conversations.getOrCreateCustomer(alice.id, phone);
  const withBob = m.conversations.getOrCreateCustomer(bob.id, phone);

  assert.notEqual(withAlice.id, withBob.id);

  m.conversations.appendMessages(withAlice.id, [{ role: "user", content: "hi alice" }]);
  m.conversations.appendMessages(withBob.id, [{ role: "user", content: "hi bob" }]);

  assert.deepEqual(
    m.conversations.getRecentMessages(withAlice.id).map((msg) => msg.content),
    ["hi alice"]
  );
  assert.deepEqual(
    m.conversations.getRecentMessages(withBob.id).map((msg) => msg.content),
    ["hi bob"]
  );
});

test("repeat texters resolve to the existing customer row", () => {
  const barber = makeBarber("Dave");
  const first = m.conversations.getOrCreateCustomer(barber.id, "+15551230001");
  const second = m.conversations.getOrCreateCustomer(barber.id, "+15551230001");
  assert.equal(first.id, second.id);
});

test("refresh tokens round-trip through encryption and never sit in plaintext", () => {
  const barber = makeBarber("Erin");
  const refreshToken = "1//real-looking-refresh-token";

  m.google.upsertGoogleAccount({
    barberId: barber.id,
    calendarId: "primary",
    refreshToken,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  assert.equal(m.google.getGoogleAccount(barber.id)?.refreshToken, refreshToken);

  const stored = m.crypto.encrypt(refreshToken);
  assert.ok(!stored.includes(refreshToken));
  assert.equal(m.crypto.decrypt(stored), refreshToken);
});

test("a tampered ciphertext is rejected rather than silently decrypted", () => {
  const encoded = m.crypto.encrypt("sensitive");
  const parts = encoded.split(".");
  const flipped = Buffer.from(parts[3]!, "base64url");
  flipped.writeUInt8(flipped.readUInt8(0) ^ 0xff, 0);

  assert.throws(() => m.crypto.decrypt([parts[0], parts[1], parts[2], flipped.toString("base64url")].join(".")));
  assert.throws(() => m.crypto.decrypt("garbage"));
});

test("needs_reauth gates calendar use until the barber reconnects", () => {
  const barber = makeBarber("Frank");
  m.google.upsertGoogleAccount({
    barberId: barber.id,
    calendarId: "primary",
    refreshToken: "1//token",
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  assert.equal(m.google.hasGoogleAccount(barber.id), true);

  m.google.markNeedsReauth(barber.id);
  assert.equal(m.google.hasGoogleAccount(barber.id), false);
  assert.equal(m.google.getGoogleAccount(barber.id)?.needsReauth, true);

  // Reconnecting clears the flag.
  m.google.upsertGoogleAccount({
    barberId: barber.id,
    calendarId: "primary",
    refreshToken: "1//token2",
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  assert.equal(m.google.hasGoogleAccount(barber.id), true);
});

test("settings changes are validated and persisted", () => {
  const barber = makeBarber("Grace");

  const updated = m.barbers.updateBarberSettings(barber.id, {
    shopName: "Grace's Cuts",
    displayName: "Grace",
    timezone: "America/Chicago",
    businessHours: "2:10:00-14:00",
    appointmentDurationMinutes: 30,
    slotIntervalMinutes: 30,
    minLeadTimeMinutes: 120,
    bookingWindowDays: 7,
    notifyPhone: null,
  });

  assert.equal(updated.shop_name, "Grace's Cuts");
  assert.equal(updated.appointment_duration_minutes, 30);
  assert.deepEqual(updated.hours.get(2), [{ startMinutes: 600, endMinutes: 840 }]);

  assert.throws(() =>
    m.barbers.updateBarberSettings(barber.id, {
      shopName: "Grace's Cuts",
      displayName: "Grace",
      timezone: "America/Chicago",
      businessHours: "2:14:00-10:00", // ends before it starts
      appointmentDurationMinutes: 30,
      slotIntervalMinutes: 30,
      minLeadTimeMinutes: 120,
      bookingWindowDays: 7,
      notifyPhone: null,
    })
  );
});
