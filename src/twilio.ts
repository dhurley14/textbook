import twilio from "twilio";
import { env, twilioWebhookUrl } from "./config";

// Built on first use so the console transport works with placeholder credentials.
let client: ReturnType<typeof twilio> | null = null;

export function twilioApi(): ReturnType<typeof twilio> {
  client ??= twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  return client;
}

/** SMS segments are 160 chars; keep replies to a couple of segments. */
const MAX_SMS_LENGTH = 320;

/** Always sent from the tenant's own number, so replies route back to the right barber. */
export async function sendSms(from: string, to: string, body: string): Promise<void> {
  const text = body.length > MAX_SMS_LENGTH ? `${body.slice(0, MAX_SMS_LENGTH - 1)}…` : body;

  if (env.SMS_TRANSPORT === "console") {
    console.log(`[sms] → ${to} (from ${from}): ${text}`);
    return;
  }

  await twilioApi().messages.create({ from, to, body: text });
}

export function validateTwilioSignature(
  signature: string | undefined,
  url: string,
  params: Record<string, string>
): boolean {
  if (!env.VALIDATE_TWILIO_SIGNATURE) return true;
  if (!signature) return false;
  return twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params);
}

export type AvailableNumber = { phoneNumber: string; locality: string | null; region: string | null };

export async function searchAvailableNumbers(areaCode?: string): Promise<AvailableNumber[]> {
  const numbers = await twilioApi()
    .availablePhoneNumbers(env.TWILIO_NUMBER_COUNTRY)
    .local.list({
      smsEnabled: true,
      limit: 5,
      ...(areaCode ? { areaCode: Number(areaCode) } : {}),
    });

  return numbers.map((n) => ({
    phoneNumber: n.phoneNumber,
    locality: n.locality ?? null,
    region: n.region ?? null,
  }));
}

/**
 * Buys a number and points it at the shared webhook. Routing is by the `To` number, so every
 * tenant's number uses the same URL.
 */
export async function purchaseNumber(phoneNumber: string, friendlyName: string) {
  return twilioApi().incomingPhoneNumbers.create({
    phoneNumber,
    friendlyName,
    smsUrl: twilioWebhookUrl,
    smsMethod: "POST",
  });
}

export async function releaseTwilioNumber(twilioSid: string): Promise<void> {
  await twilioApi().incomingPhoneNumbers(twilioSid).remove();
}
