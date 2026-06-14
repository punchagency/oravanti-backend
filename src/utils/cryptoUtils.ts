import crypto from "crypto";

const PRIMARY_KEY = Buffer.from(
  process.env.SERVER_MASTER_KEY_PRIMARY as string,
  "hex",
);

export interface EncryptedPackage {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface UserKeysPackage {
  encryptedDEK: string;
  dekIv: string;
  dekTag: string;
}

export function generateUserDEK(): UserKeysPackage {
  const rawDEK = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv("aes-256-gcm", PRIMARY_KEY, iv);
  const encryptedDEK = Buffer.concat([cipher.update(rawDEK), cipher.final()]);

  return {
    encryptedDEK: encryptedDEK.toString("hex"),
    dekIv: iv.toString("hex"),
    dekTag: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptUserDEK(
  storedKeys: {
    encryptedDEK: string | null;
    dekIv: string | null;
    dekTag: string | null;
  },
  masterKeyBuffer: Buffer,
): Buffer {
  const iv = Buffer.from(storedKeys.dekIv!, "hex");
  const authTag = Buffer.from(storedKeys.dekTag!, "hex");
  const encryptedDEK = Buffer.from(storedKeys.encryptedDEK!, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKeyBuffer, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedDEK), decipher.final()]);
}

export function rotateUserDEK(
  storedKeys: {
    encryptedDEK: string | null;
    dekIv: string | null;
    dekTag: string | null;
  },
  oldKeyBuffer: Buffer,
  newKeyBuffer: Buffer,
): UserKeysPackage {
  const rawDEK = decryptUserDEK(storedKeys, oldKeyBuffer);

  const newIv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", newKeyBuffer, newIv);
  const reEncryptedDEK = Buffer.concat([cipher.update(rawDEK), cipher.final()]);

  return {
    encryptedDEK: reEncryptedDEK.toString("hex"),
    dekIv: newIv.toString("hex"),
    dekTag: cipher.getAuthTag().toString("hex"),
  };
}

export function encryptData(
  plaintext: string,
  rawDEK: Buffer,
): EncryptedPackage {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", rawDEK, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptData(
  payload: { ciphertext: string; iv: string; authTag: string },
  rawDEK: Buffer,
): string {
  const iv = Buffer.from(payload.iv, "hex");
  const authTag = Buffer.from(payload.authTag, "hex");
  const ciphertext = Buffer.from(payload.ciphertext, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", rawDEK, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
