import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import { env } from "../config/env";
import { ExternalServiceError } from "./error/app-error";

/**
 * Symmetric encryption for payment credentials at rest.
 *
 * Lifted verbatim out of `modules/auth/auth.service.ts`, where it was private
 * and encrypt-only: contractor bank details are written and never read back, so
 * a decrypt half was never needed. A payment-processor API token has to
 * round-trip, so both halves live here now and both call sites share them.
 *
 * The key derivation and ciphertext format are deliberately UNCHANGED. Existing
 * `contractor_payment_details` rows were written with this exact scheme; altering
 * either would make them undecryptable the moment anything tries to read one.
 */

/**
 * AES-256 needs exactly 32 bytes, and the configured secret is an arbitrary
 * string, so it is hashed rather than used directly.
 *
 * The `CONTRACTOR_PAYMENT_ENCRYPTION_KEY || PAYMENT_ENCRYPTION_KEY` fallback is
 * inherited, not chosen. It means the key in force depends on whether an
 * optional variable happens to be set — so setting or unsetting it between
 * deploys silently changes which ciphertexts can be read. That was harmless
 * while nothing decrypted; it is not harmless now. Callers that store
 * recoverable credentials should treat a decrypt failure as "reconnect this
 * account", not as a server error.
 */
const getPaymentEncryptionKey = () => {
  const secret =
    env.CONTRACTOR_PAYMENT_ENCRYPTION_KEY || env.PAYMENT_ENCRYPTION_KEY;

  if (!secret) {
    throw new ExternalServiceError("Payment encryption key is not configured");
  }

  return createHash("sha256").update(secret).digest();
};

/** True when a key is available, so callers can refuse early rather than throw mid-write. */
export const isPaymentEncryptionConfigured = (): boolean =>
  Boolean(env.CONTRACTOR_PAYMENT_ENCRYPTION_KEY || env.PAYMENT_ENCRYPTION_KEY);

/**
 * AES-256-GCM. Returns `iv:authTag:ciphertext`, all hex.
 *
 * GCM rather than CBC so tampering is detected on read: a modified ciphertext
 * fails the auth tag instead of decrypting to plausible garbage.
 */
export const encryptPaymentValue = (value: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getPaymentEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value.trim(), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
};

/**
 * Thrown when a stored value cannot be recovered — wrong key, or tampering.
 *
 * Distinct from a generic error because the two causes a caller can act on are
 * both "the credential is gone, ask the user to reconnect", and that is a very
 * different response from a 500.
 */
export class PaymentDecryptionError extends Error {
  constructor(message = "Stored payment credential could not be decrypted") {
    super(message);
    this.name = "PaymentDecryptionError";
  }
}

/**
 * Reverse of `encryptPaymentValue`. Throws `PaymentDecryptionError` rather than
 * a raw crypto error, so callers can map it to a reconnect prompt.
 */
export const decryptPaymentValue = (stored: string): string => {
  const parts = stored.split(":");
  if (parts.length !== 3) {
    throw new PaymentDecryptionError("Malformed encrypted payment value");
  }

  const [ivHex, authTagHex, cipherHex] = parts as [string, string, string];

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      getPaymentEncryptionKey(),
      Buffer.from(ivHex, "hex"),
    );
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

    return Buffer.concat([
      decipher.update(Buffer.from(cipherHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    // A missing key is a configuration fault and should surface as itself; an
    // auth-tag failure is a bad ciphertext and should surface as one.
    if (err instanceof ExternalServiceError) throw err;
    throw new PaymentDecryptionError();
  }
};
