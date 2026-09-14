import { Router, type Request } from "express";
import { appUrl, env } from "../config";
import { findBarberByPhoneNumber } from "../db/barbers";
import { getOrCreateCustomer } from "../db/conversations";
import { claimSmsForProcessing } from "../db";
import { handleCustomerMessage } from "../agent";
import { ReauthRequiredError } from "../calendar/client";
import { runExclusive } from "../queue";
import { sendSms, validateTwilioSignature } from "../twilio";

export const smsRouter = Router();

/** Carrier opt-out keywords; Twilio handles the compliance reply, we just stay quiet. */
const OPT_OUT = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "start", "unstop", "help", "info"]);

/** Twilio signs the exact URL it requested, which is the public one, not what Express sees. */
function requestUrl(req: Request): string {
  return new URL(req.originalUrl, appUrl).toString();
}

smsRouter.post("/sms", (req, res) => {
  const params = req.body as Record<string, string>;

  if (!validateTwilioSignature(req.get("X-Twilio-Signature"), requestUrl(req), params)) {
    console.warn("[sms] rejected request with an invalid Twilio signature");
    res.status(403).send("Invalid signature");
    return;
  }

  const from = params.From;
  const to = params.To;
  const body = (params.Body ?? "").trim();
  const messageSid = params.MessageSid ?? `${from}-${Date.now()}`;

  // Ack right away: the model plus two calendar round-trips can outlast Twilio's webhook timeout,
  // so the reply goes out through the REST API instead of TwiML.
  res.type("text/xml").send("<Response></Response>");

  if (!from || !to || !body) return;
  if (OPT_OUT.has(body.toLowerCase())) return;

  // `To` is the tenant key: it's the number this barber hands out to their customers.
  const barber = findBarberByPhoneNumber(to);
  if (!barber) {
    console.warn(`[sms] message to unrecognized number ${to}`);
    return;
  }

  if (!claimSmsForProcessing(messageSid)) {
    console.log(`[sms] ignoring duplicate delivery of ${messageSid}`);
    return;
  }

  // Serialize per conversation, not per tenant, so one barber's customers don't queue behind
  // each other while still preventing a single customer from double-booking.
  void runExclusive(`${barber.id}:${from}`, async () => {
    console.log(`[sms] ${barber.shop_name} <- ${from}: ${body}`);
    const customer = getOrCreateCustomer(barber.id, from);

    try {
      const result = await handleCustomerMessage(barber, customer, body);
      await sendSms(to, from, result.reply);

      if (result.booking && barber.notify_phone) {
        await sendSms(
          to,
          barber.notify_phone,
          `New booking: ${result.booking.customerName} on ${result.booking.label} (${from}).`
        );
      }
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        console.error(`[sms] barber ${barber.id} needs to reconnect Google Calendar`);
        await sendSms(
          to,
          from,
          `Sorry, we can't check the schedule right now. ${barber.display_name} will text you back shortly.`
        ).catch(() => undefined);
        await notifyBarberOfReauth(barber.notify_phone, to, barber.shop_name);
        return;
      }

      console.error(`[sms] failed to handle message from ${from}`, error);
      await sendSms(
        to,
        from,
        `Sorry, something went wrong booking that. ${barber.display_name} will text you back shortly.`
      ).catch((sendError) => console.error("[sms] fallback send failed", sendError));
    }
  });
});

async function notifyBarberOfReauth(notifyPhone: string | null, from: string, shopName: string): Promise<void> {
  if (!notifyPhone) return;
  await sendSms(
    from,
    notifyPhone,
    `${shopName}: your Google Calendar connection expired, so we can't book appointments. Reconnect at ${appUrl}/dashboard`
  ).catch((error) => console.error("[sms] reauth notice failed", error));
}

export const smsWebhookPath = "/sms";
export const validateSignatures = env.VALIDATE_TWILIO_SIGNATURE;
