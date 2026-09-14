/**
 * Attaches a fake phone number to a barber so the SMS flow can be tested locally.
 *
 *   npm run seed:number
 *   npm run seed:number -- --email me@example.com --number +15550001111
 *
 * Inbound texts are routed by the number they were sent to, so /sms ignores anything addressed to a
 * number no barber owns. Normally you'd get one by clicking "Activate my number", which buys a real
 * number from Twilio. This writes the same row without spending anything — good enough for
 * scripts/mock-sms.sh, useless for texts from an actual phone.
 */
import { db } from "../db/index";
import { type BarberRow } from "../db/barbers";
import { getNumberForBarber, recordNumber } from "../db/numbers";
import { hasGoogleAccount } from "../db/google";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function die(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const email = arg("email");
const e164 = arg("number") ?? "+15550001111";

if (!/^\+\d{8,15}$/.test(e164)) {
  die(`"${e164}" is not an E.164 number (for example +15550001111).`);
}

const barbers = db.prepare(`SELECT * FROM barbers ORDER BY created_at`).all() as BarberRow[];

if (barbers.length === 0) {
  die("No barbers yet. Run 'npm run dev' and sign in with Google first.");
}

let target: BarberRow;
if (email) {
  const match = barbers.find((barber) => barber.email === email);
  if (!match) die(`No barber with email ${email}. Found: ${barbers.map((b) => b.email).join(", ")}`);
  target = match;
} else if (barbers.length === 1) {
  target = barbers[0]!;
} else {
  die(`Several barbers exist, so pass --email <one of: ${barbers.map((b) => b.email).join(", ")}>`);
}

const existing = getNumberForBarber(target.id);
if (existing) {
  console.log(`${target.shop_name} already has ${existing.e164}. Nothing to do.`);
  process.exit(0);
}

// e164 is UNIQUE across every row, released ones included, so check before hitting the constraint.
const taken = db
  .prepare(
    `SELECT b.email, p.status FROM phone_numbers p
     JOIN barbers b ON b.id = p.barber_id
     WHERE p.e164 = ?`
  )
  .get(e164) as { email: string; status: string } | undefined;

if (taken) {
  die(`${e164} is already on record for ${taken.email} (${taken.status}). Pass a different --number.`);
}

recordNumber({ barberId: target.id, e164, twilioSid: `PNSEEDED${Date.now()}` });

console.log(`✓ ${e164} now routes to ${target.shop_name} (${target.email})`);
console.log(`  Try it:  npm run mock:sms -- "any openings thursday?"`);

if (!hasGoogleAccount(target.id)) {
  console.log(
    `\n! ${target.email} has no Google Calendar connected, so the agent can chat but can't` +
      `\n  check availability or book. Sign in again at the dashboard to grant calendar access.`
  );
}

console.log(
  `\n  This number is fake: Twilio has never heard of it, so real texts won't arrive and` +
    `\n  releasing it from the dashboard will fail. Use it only with scripts/mock-sms.sh.`
);
