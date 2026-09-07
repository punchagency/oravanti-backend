import { eq } from "drizzle-orm";

import { auth } from "../../auth";
import { systemDb } from "../client";
import { user } from "../schema/auth-schema";
import { platformAdmins } from "../schema/platform-admins";

/**
 * Creates the first Oravanti operator — the only door into the platform tier.
 *
 * There is deliberately no signup page and no invitation email for this. An
 * operator account can edit the form catalogue every firm in the deployment
 * reads, so the ability to mint one is the ability to change what every firm's
 * I-485 asks; that belongs to whoever already holds the database, not to
 * anything reachable over HTTP.
 *
 * Idempotent, so re-running it after a schema push is safe: an existing
 * operator has their name refreshed rather than a second row written.
 */
export async function seedPlatformAdmin(input: {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}) {
  const email = input.email.toLowerCase().trim();
  const name = `${input.firstName} ${input.lastName}`.trim();

  const [existingUser] = await systemDb
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  let userId = existingUser?.id;

  if (!userId) {
    const { user: created } = await auth.api.signUpEmail({
      body: {
        name,
        email,
        password: input.password,
        accountType: "platform_admin",
        onboardingState: "completed",
      },
    });
    userId = created.id;
  }

  // Set unconditionally rather than only on creation. An address that already
  // had a firm account and is being promoted must actually change tier, and a
  // half-promoted user — `platform_admins` row present, `accountType` still
  // "staff" — would be handed a tenant connection by `requireAuth` and read
  // the platform catalogue through RLS, which shows it nothing.
  await systemDb
    .update(user)
    .set({
      accountType: "platform_admin",
      onboardingState: "completed",
      // Verified by the act of seeding: whoever ran this already holds the
      // database. There is no verification email to wait for.
      emailVerified: true,
      tosAccepted: true,
      tosAcceptedAt: new Date(),
    })
    .where(eq(user.id, userId));

  const [operator] = await systemDb
    .insert(platformAdmins)
    .values({
      userId,
      firstName: input.firstName,
      lastName: input.lastName,
      email,
    })
    .onConflictDoUpdate({
      target: platformAdmins.userId,
      set: {
        firstName: input.firstName,
        lastName: input.lastName,
        email,
        updatedAt: new Date(),
      },
    })
    .returning();

  return { operator, created: !existingUser };
}
