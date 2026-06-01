import { eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { organization } from "../../../db/schema/auth-schema";
import { UpsertFirmInfoBody } from "../../../types/settings.types";

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const toFirmInfo = (row: typeof organization.$inferSelect) => ({
  id: row.id,
  firmName: row.name,
  firmEmail: row.emailAddress,
  firmPhone: row.phoneNumber,
  address: row.address,
  city: row.city,
  state: row.state,
  zipCode: row.zipCode,
  website: row.website,
  taxId: row.taxId,
  createdAt: row.createdAt,
});

const toOrganizationValues = (body: UpsertFirmInfoBody) => ({
  name: body.firmName,
  emailAddress: body.firmEmail,
  phoneNumber: body.firmPhone,
  address: body.address,
  city: body.city,
  state: body.state,
  zipCode: body.zipCode,
  website: body.website,
  taxId: body.taxId,
});

export class FirmInfoService {
  getFirmInfo = async (organizationId: string) => {
    const result = await db
      .select()
      .from(organization)
      .where(eq(organization.id, organizationId));
    return result[0] ? toFirmInfo(result[0]) : null;
  };

  upsertFirmInfo = async (
    organizationId: string,
    body: UpsertFirmInfoBody,
  ) => {
    const existing = await this.getFirmInfo(organizationId);

    if (existing) {
      const [updated] = await db
        .update(organization)
        .set(toOrganizationValues(body))
        .where(eq(organization.id, organizationId))
        .returning();
      return toFirmInfo(updated);
    }

    const [created] = await db
      .insert(organization)
      .values({
        id: organizationId,
        slug: `${slugify(body.firmName) || "organization"}-${organizationId}`,
        createdAt: new Date(),
        ...toOrganizationValues(body),
      })
      .returning();
    return toFirmInfo(created);
  };
}
