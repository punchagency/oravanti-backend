import { eq } from "drizzle-orm";
import { NextFunction, Request, Response } from "express";
import { db } from "../config/db";
import { env } from "../config/env";
import { AuthRequest } from "../middleware/auth.middleware";
import { decryptUserDEK, rotateUserDEK } from "../utils/cryptoUtils";
import { user } from "./../db/schema/auth-schema";

const PRIMARY_KEY = Buffer.from(env.SERVER_MASTER_KEY_PRIMARY, "hex");
const OLD_KEY = env.SERVER_MASTER_KEY_OLD
  ? Buffer.from(env.SERVER_MASTER_KEY_OLD, "hex")
  : null;

export async function injectUserDEK(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) {
  if (!req.userId) {
    return res
      .status(401)
      .json({ error: "Authentication required before key injection." });
  }

  try {
    const [userKeys] = await db
      .select({
        id: user.id,
        email: user.email,
        encryptedDEK: user.encryptedDEK,
        dekIv: user.dekIv,
        dekTag: user.dekTag,
      })
      .from(user)
      .where(eq(user.id, req.userId))
      .limit(1);

    if (!userKeys || !userKeys.encryptedDEK) {
      return res
        .status(400)
        .json({ error: "Cryptographic system data missing on target record." });
    }

    try {
      req.rawUserDEK = decryptUserDEK(userKeys, PRIMARY_KEY);
      return next();
    } catch (primaryErr) {
      if (!OLD_KEY) {
        console.error(
          `🚨 CRITICAL CRYPTO_VERIFICATION_FAILURE for user ${userKeys.id}: no old key configured`,
        );
        return res.status(500).json({
          error: "Cryptographic verification failure. Record is unreadable.",
        });
      }

      try {
        req.rawUserDEK = decryptUserDEK(userKeys, OLD_KEY);

        console.warn(
          `[LAZY_MIGRATION] Running re-keying background task for: ${userKeys.email}`,
        );

        const upgradedKeys = rotateUserDEK(userKeys, OLD_KEY, PRIMARY_KEY);

        db.update(user)
          .set({
            encryptedDEK: upgradedKeys.encryptedDEK,
            dekIv: upgradedKeys.dekIv,
            dekTag: upgradedKeys.dekTag,
          })
          .where(eq(user.id, userKeys.id))
          .catch((dbErr) => {
            console.error(
              `🚨 [LAZY_MIGRATION_WRITE_ERROR] Failed for user ${userKeys.id}:`,
              dbErr,
            );
          });

        return next();
      } catch (fallbackErr) {
        console.error(
          `🚨 CRITICAL CRYPTO_VERIFICATION_FAILURE for user ${userKeys.id}`,
        );
        return res.status(500).json({
          error: "Cryptographic verification failure. Record is unreadable.",
        });
      }
    }
  } catch (error) {
    return res.status(500).json({ error: "Internal processing error." });
  }
}
