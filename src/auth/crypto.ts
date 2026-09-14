import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { decodeEncryptionKey } from "../config";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const key = decodeEncryptionKey();

/**
 * A Google refresh token is a long-lived key to a barber's calendar, so it never sits in the
 * database in plaintext. Format: v1.<iv>.<authTag>.<ciphertext>, all base64url.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(
    "."
  );
}

export function decrypt(encoded: string): string {
  const [version, iv, authTag, ciphertext] = encoded.split(".");

  if (version !== "v1" || !iv || !authTag || !ciphertext) {
    throw new Error("Stored credential is not in the expected encrypted format");
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(authTag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
