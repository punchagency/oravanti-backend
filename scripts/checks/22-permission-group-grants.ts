/**
 * `hasPermission` must agree with `requirePermission` about role groups.
 *
 * Both are in `permission.middleware.ts` and both answer "may this member do
 * this". `requirePermission` gates the request; `hasPermission` is the
 * non-throwing form handlers call to branch on a permission they were already
 * admitted with. better-auth resolves `member.role` alone and knows nothing of
 * this app's role groups, so both need the `resolveMemberGrants` fallback.
 *
 * Only `requirePermission` had it. A member granted a permission solely through
 * a role group therefore passed the route gate and was then told "no" inside
 * the handler — which is exactly the divergence `resolveMemberGrants` was
 * written to prevent.
 *
 * Runs against the TEST database (npm run check 22-permission-group-grants)
 * and cleans up the org it creates.
 */
import { randomUUID } from "crypto";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { closeDb, systemDb } from "../../src/db/client";
import { member, organization, user } from "../../src/db/schema/auth-schema";
import { roleGroup, roleGroupMember } from "../../src/db/schema/role-groups";
import { hasPermission } from "../../src/middleware/permission.middleware";
import { runWithRequestContext } from "../../src/middleware/request-context";
import { check, report, section } from "./_bootstrap";

const main = async () => {
  const suffix = randomUUID().slice(0, 8);
  const orgId = `check-org-${suffix}`;
  const now = new Date();

  // No session, so better-auth cannot answer; the fallback is what responds.
  // That is the path under test, and it is why the fallback must not sit inside
  // the try that swallows a better-auth failure.
  const req = { headers: {} } as unknown as Request;

  const ask = (userId: string) =>
    runWithRequestContext({ source: "system", userId, organizationId: orgId }, () =>
      hasPermission(req, { finance: ["refund"] }),
    );

  try {
    await systemDb.insert(organization).values({
      id: orgId,
      name: `Check Org ${suffix}`,
      slug: `check-org-${suffix}`,
      createdAt: now,
    });

    const mk = async (label: string, role: string) => {
      const userId = `check-${label}-${suffix}`;
      await systemDb.insert(user).values({
        id: userId,
        name: `Check ${label}`,
        email: `${label}-${suffix}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      const [m] = await systemDb
        .insert(member)
        .values({
          id: `member-${label}-${suffix}`,
          organizationId: orgId,
          userId,
          role,
          createdAt: now,
        })
        .returning();
      return { userId, memberId: m!.id };
    };

    // `attorney` does not carry finance:refund; `admin` does.
    const plain = await mk("plain", "attorney");
    const direct = await mk("direct", "admin");
    const viaGroup = await mk("group", "attorney");

    section("Direct roles still resolve");
    check("a member with no refund grant is refused", !(await ask(plain.userId)));
    check("a member whose own role grants it is allowed", await ask(direct.userId));

    section("A permission held only through a role group");

    const [group] = await systemDb
      .insert(roleGroup)
      .values({
        organizationId: orgId,
        name: `Finance ${suffix}`,
        roles: "admin",
      })
      .returning();

    check(
      "before joining the group, still refused",
      !(await ask(viaGroup.userId)),
    );

    await systemDb.insert(roleGroupMember).values({
      groupId: group!.id,
      memberId: viaGroup.memberId,
    });

    check(
      "after joining, hasPermission agrees with requirePermission",
      await ask(viaGroup.userId),
    );
  } finally {
    await systemDb.delete(roleGroupMember);
    await systemDb.delete(roleGroup).where(eq(roleGroup.organizationId, orgId));
    await systemDb.delete(member).where(eq(member.organizationId, orgId));
    await systemDb.delete(organization).where(eq(organization.id, orgId));
    for (const label of ["plain", "direct", "group"]) {
      await systemDb.delete(user).where(eq(user.id, `check-${label}-${suffix}`));
    }
  }

  await report();
  await closeDb();
};

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
