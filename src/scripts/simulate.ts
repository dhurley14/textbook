/**
 * Chat with a barber's booking agent from the terminal, without Twilio.
 * Real OpenAI and Google Calendar calls are made, so bookings land on the calendar.
 *
 *   npm run simulate                      # picks the only barber, or lists them
 *   npm run simulate -- <barberId>
 *   npm run simulate -- <barberId> +15555551234
 */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { db } from "../db";
import { findBarberById } from "../db/barbers";
import { getOrCreateCustomer } from "../db/conversations";
import { handleCustomerMessage } from "../agent";

function pickBarber(explicitId?: string) {
  if (explicitId) {
    const barber = findBarberById(explicitId);
    if (!barber) throw new Error(`No barber with id ${explicitId}`);
    return barber;
  }

  const rows = db.prepare(`SELECT id, shop_name FROM barbers ORDER BY created_at`).all() as {
    id: string;
    shop_name: string;
  }[];

  if (rows.length === 0) throw new Error("No barbers have signed up yet. Sign in through the web app first.");
  if (rows.length > 1) {
    throw new Error(
      `Several barbers exist; pass one of these ids:\n${rows.map((r) => `  ${r.id}  ${r.shop_name}`).join("\n")}`
    );
  }

  return findBarberById(rows[0]!.id)!;
}

async function main() {
  const barber = pickBarber(process.argv[2]);
  const phone = process.argv[3] ?? "+15555550199";
  const customer = getOrCreateCustomer(barber.id, phone);
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log(`Simulating texts from ${phone} to ${barber.shop_name}. Ctrl+C to quit.\n`);

  for (;;) {
    const text = (await rl.question(`${phone} > `)).trim();
    if (!text) continue;
    if (text === "/quit") break;

    const result = await handleCustomerMessage(barber, customer, text);
    console.log(`\n${barber.shop_name} > ${result.reply}\n`);
    if (result.booking) console.log(`[calendar event created: ${result.booking.eventId}]\n`);
  }

  rl.close();
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
