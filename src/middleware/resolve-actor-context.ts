import { eq, and } from "drizzle-orm";
import { Request, Response, NextFunction } from "express";
import { db, systemDb } from "../db/client";
import { user } from "../db/schema/auth-schema";
import { staff } from "../db/schema/staff";
import {
  getRequestContext,
  setRequestContext,
  type ActorType,
} from "./request-context";
import { refreshServiceLogger } from "../lib/logging/service-logger";

/**
 * Maps user.accountType onto the audit vocabulary. firm_admin and staff are
 * the same kind of actor for audit purposes — the distinction that matters
 * there is what they did, which permissions already govern.
 */
const ACTOR_TYPE_BY_ACCOUNT: Record<string, ActorType> = {
  firm_admin: "staff",
  staff: "staff",
  contractor: "contractor",
  client: "client",
  platform_admin: "platform",
};

export async function resolveActorContext(
  _req: Request,
  _res: Response,
  next: NextFunction,
) {
  const { userId, organizationId } = getRequestContext();

  if (!userId) {
    return next();
  }

  try {
    // Selecting name and email alongside accountType costs nothing here —
    // it is the same row — and it is what lets audit writes stop issuing a
    // SELECT per event to resolve the actor's display name.
    const [userRecord] = await systemDb
      .select({
        accountType: user.accountType,
        name: user.name,
        email: user.email,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    const accountType = userRecord?.accountType;

    setRequestContext({
      actorType: accountType
        ? (ACTOR_TYPE_BY_ACCOUNT[accountType] ?? "anonymous")
        : "anonymous",
      // Falls back to email so a row is never attributed to nobody. An
      // actor_name of null in the audit trail is indistinguishable from a
      // deleted account, which is the ambiguity this exists to prevent.
      actorName: userRecord?.name?.trim() || userRecord?.email || null,
    });

    /*
      A platform admin has no firm, and must never acquire one.

      This is the second half of the guarantee `requireAuth` starts: it opens
      no tenant connection for an operator, and this refuses to resolve one a
      different way. Returning here means no `staffId`, no staff-table lookup,
      and no path by which an Oravanti account comes to be treated as a member
      of somebody's firm. **Oravanti staff see no firm data** — that is a claim
      the firms buying this product will ask about, and these two lines are
      where it is true rather than merely intended.

      The audit trail still names them: `actorType` is "platform" and
      `actorName` was set above, so a catalogue edit is attributed to the
      person who made it.
    */
    if (accountType === "platform_admin") {
      setRequestContext({ organizationId: null, staffId: null });
      refreshServiceLogger();
      return next();
    }

    // Staff/firm_admin: resolve staffId from staff table
    if ((accountType === "staff" || accountType === "firm_admin") && organizationId) {
      const [staffRecord] = await db
        .select({
          id: staff.id,
          firstName: staff.firstName,
          lastName: staff.lastName,
        })
        .from(staff)
        .where(
          and(
            eq(staff.userId, userId),
            eq(staff.organizationId, organizationId),
          ),
        )
        .limit(1);

      setRequestContext({ staffId: staffRecord?.id ?? null });

      // The staff record is the firm's own name for this person, so it wins
      // over the auth account's name where the two disagree.
      if (staffRecord) {
        const staffName = `${staffRecord.firstName} ${staffRecord.lastName}`.trim();
        if (staffName) setRequestContext({ actorName: staffName });
      }
    }
    // Clients/contractors: no staffId, just userId (already set by requireAuth)
  } catch {
    setRequestContext({ staffId: null });
  }

  // Correlation fields are now complete; drop any child logger bound to the
  // thinner context so subsequent lines carry userId, staffId and actorType.
  refreshServiceLogger();

  next();
}
