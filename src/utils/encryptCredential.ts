import crypto from "crypto";
import { env } from "../config/env";

const ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY = env.EMAIL_ENCRYPTION_KEY;

export function encryptCredential(text: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY, "hex"),
    iv,
  );

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return {
    content: encrypted,
    iv: iv.toString("hex"),
    tag: tag,
  };
}

export function decryptCredential(
  encrypted: string,
  ivHex: string,
  tagHex: string,
): string {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY, "hex"),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
