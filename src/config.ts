import { createHash } from "node:crypto";
import dotenv from "dotenv";
import { z } from "zod";
import { parseBusinessHours } from "./availability";

export type { HoursRange, WeeklyHours } from "./availability";

// Which dotenv file to read. `scripts/dev.sh` points this at .env.dev so local settings never
// collide with a .env used for anything else. Real deployments set env vars directly, and a
// missing file here is not an error.
export const envFile = process.env.ENV_FILE ?? ".env";
dotenv.config({ path: envFile });

/**
 * Platform-level configuration only. Anything that varies per barber — hours, timezone, duration,
 * calendar, phone number — lives in the database, keyed by tenant.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  /** Public https base URL. Used for OAuth redirects and Twilio webhook registration. */
  APP_URL: z.string().url(),

  // One platform Twilio account owns every tenant's number.
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  VALIDATE_TWILIO_SIGNATURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** ISO country to buy numbers in. */
  TWILIO_NUMBER_COUNTRY: z.string().length(2).default("US"),
  /** "console" prints outbound texts to the log instead of sending them. Local testing only. */
  SMS_TRANSPORT: z.enum(["twilio", "console"]).default("twilio"),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),

  // A single OAuth web client; every barber grants access through it.
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),

  /** 32 bytes, hex or base64. Encrypts Google refresh tokens at rest. */
  ENCRYPTION_KEY: z.string().min(1),

  DATABASE_PATH: z.string().default("./data/app.sqlite"),

  // Defaults applied to a barber's profile at signup; each is editable in the dashboard.
  DEFAULT_TIMEZONE: z.string().default("America/New_York"),
  DEFAULT_BUSINESS_HOURS: z
    .string()
    .default("1:09:00-17:00,2:09:00-17:00,3:09:00-17:00,4:09:00-19:00,5:09:00-19:00,6:10:00-16:00"),
  DEFAULT_APPOINTMENT_DURATION_MINUTES: z.coerce.number().int().positive().default(45),
});

/**
 * Hosting dashboards store a cleared env var as an empty string rather than dropping it, which
 * would otherwise beat the defaults above.
 */
const rawEnv: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined && value.trim() !== "")
) as Record<string, string>;

// Render injects the service's real https URL. Twilio signs the exact URL it called and Google
// requires an exact redirect URI match, so both derive from this.
if (!rawEnv.APP_URL && rawEnv.RENDER_EXTERNAL_URL) {
  rawEnv.APP_URL = rawEnv.RENDER_EXTERNAL_URL;
}

const parsed = envSchema.safeParse(rawEnv);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  throw new Error(
    `Invalid environment configuration (reading ${envFile}):\n${issues}\n\nCopy .env.example to ${envFile} and fill it in.`
  );
}

export const env = parsed.data;

export const appUrl = env.APP_URL.replace(/\/$/, "");
export const googleRedirectUri = `${appUrl}/auth/google/callback`;
export const twilioWebhookUrl = `${appUrl}/sms`;

// Fail at boot rather than at a barber's first booking.
parseBusinessHours(env.DEFAULT_BUSINESS_HOURS);

/**
 * AES-256 needs exactly 32 bytes. A 64-char hex key is used verbatim; anything else is hashed to
 * 32 bytes so a platform-generated secret of arbitrary length also works. Either way the mapping
 * is stable — changing ENCRYPTION_KEY makes every stored refresh token undecryptable.
 */
export function decodeEncryptionKey(): Buffer {
  const raw = env.ENCRYPTION_KEY.trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");

  if (raw.length < 24) {
    throw new Error(
      "ENCRYPTION_KEY is too short to be a secret. Generate one with: openssl rand -hex 32"
    );
  }
  return createHash("sha256").update(raw, "utf8").digest();
}
