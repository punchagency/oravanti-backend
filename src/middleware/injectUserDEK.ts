import { eq } from "drizzle-orm";
import { NextFunction, Request, Response } from "express";
import { systemDb } from "../db/client";
import { env } from "../config/env";
import { getRequestContext, setRequestContext } from "../middleware/request-context";
import { decryptUserDEK, rotateUserDEK } from "../utils/cryptoUtils";
import { LogEvent, createModuleLogger } from "../lib/logging/log";
import { user } from "./../db/schema/auth-schema";

const log = createModuleLogger("middleware.inject_user_dek");

const PRIMARY_KEY = Buffer.from(env.SERVER_MASTER_KEY_PRIMARY, "hex");
const OLD_KEY = env.SERVER_MASTER_KEY_OLD
  ? Buffer.from(env.SERVER_MASTER_KEY_OLD, "hex")
  : null;

export async function injectUserDEK(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  const { userId } = getRequestContext();

  if (!userId) {
    return res
      .status(401)
      .json({ error: "Authentication required before key injection." });
  }

  try {
    const [userKeys] = await systemDb
      .select({
        id: user.id,
        email: user.email,
        encryptedDEK: user.encryptedDEK,
        dekIv: user.dekIv,
        dekTag: user.dekTag,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (!userKeys || !userKeys.encryptedDEK) {
      return res
        .status(400)
        .json({ error: "Cryptographic system data missing on target record." });
    }

    try {
      setRequestContext({ rawUserDEK: decryptUserDEK(userKeys, PRIMARY_KEY) });
      return next();
    } catch (primaryErr) {
      if (!OLD_KEY) {
        // The user's key cannot be unwrapped and there is no previous master
        // key to fall back to. Their encrypted data is unreadable until this
        // is resolved, so it is an error, not a warning.
        log.failure(LogEvent.SECURITY_DEK_DECRYPT_FAILED, primaryErr, {
          targetUserId: userKeys.id,
          oldKeyConfigured: false,
        });
        return res.status(500).json({
          error: "Cryptographic verification failure. Record is unreadable.",
        });
      }

      try {
        setRequestContext({ rawUserDEK: decryptUserDEK(userKeys, OLD_KEY) });

        // The email is deliberately not logged: identifying the user by id is
        // enough to act on, and this line is written on every request from
        // every user still on the old key.
        log.info(LogEvent.SECURITY_DEK_ROTATED, {
          targetUserId: userKeys.id,
        });

        const upgradedKeys = rotateUserDEK(userKeys, OLD_KEY, PRIMARY_KEY);

        systemDb.update(user)
          .set({
            encryptedDEK: upgradedKeys.encryptedDEK,
            dekIv: upgradedKeys.dekIv,
            dekTag: upgradedKeys.dekTag,
          })
          .where(eq(user.id, userKeys.id))
          .catch((dbErr) => {
            // The request succeeds — the key was unwrapped with the old key —
            // but this user stays on it, so the rotation is not finished and
            // the old key cannot be retired.
            log.failure(LogEvent.SECURITY_DEK_ROTATION_FAILED, dbErr, {
              targetUserId: userKeys.id,
            });
          });

        return next();
      } catch (fallbackErr) {
        // Neither key unwraps it. Either the record is corrupt or it was
        // written under a key that is no longer configured at all.
        log.failure(LogEvent.SECURITY_DEK_DECRYPT_FAILED, fallbackErr, {
          targetUserId: userKeys.id,
          oldKeyConfigured: true,
        });
        return res.status(500).json({
          error: "Cryptographic verification failure. Record is unreadable.",
        });
      }
    }
  } catch (error) {
    // Previously swallowed in silence: the caller got a 500 and nothing
    // anywhere recorded why, which made this branch untraceable in production.
    log.failure(LogEvent.SECURITY_DEK_INJECTION_FAILED, error, { userId });
    return res.status(500).json({ error: "Internal processing error." });
  }
}
