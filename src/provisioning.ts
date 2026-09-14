import type { Barber } from "./db/barbers";
import { getNumberForBarber, recordNumber, releaseNumber, type PhoneNumberRow } from "./db/numbers";
import { hasGoogleAccount } from "./db/google";
import { purchaseNumber, releaseTwilioNumber, searchAvailableNumbers } from "./twilio";

export class ProvisioningError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "ProvisioningError";
  }
}

/**
 * Buys the barber a number and points it at the shared webhook. Called from an explicit Activate
 * action rather than at signup, because every number bills from the moment it exists.
 */
export async function activateNumberForBarber(barber: Barber, areaCode?: string): Promise<PhoneNumberRow> {
  const existing = getNumberForBarber(barber.id);
  if (existing) return existing;

  // A number without a working calendar would take bookings it can't honor.
  if (!hasGoogleAccount(barber.id)) {
    throw new ProvisioningError("Connect Google Calendar before activating a number.", "calendar_required");
  }

  const candidates = await searchAvailableNumbers(areaCode);
  if (candidates.length === 0) {
    throw new ProvisioningError(
      areaCode ? `No SMS numbers available in area code ${areaCode}.` : "No SMS numbers available right now.",
      "none_available"
    );
  }

  const purchased = await purchaseNumber(candidates[0]!.phoneNumber, `textbook · ${barber.shop_name}`);

  try {
    return recordNumber({
      barberId: barber.id,
      e164: purchased.phoneNumber,
      twilioSid: purchased.sid,
    });
  } catch (error) {
    // Don't leave a purchased number billing against an account we have no record of.
    await releaseTwilioNumber(purchased.sid).catch((releaseError) =>
      console.error("[provisioning] failed to release orphaned number", releaseError)
    );
    throw error;
  }
}

export async function deactivateNumberForBarber(barber: Barber): Promise<void> {
  const existing = getNumberForBarber(barber.id);
  if (!existing) return;

  await releaseTwilioNumber(existing.twilio_sid);
  releaseNumber(barber.id);
}
