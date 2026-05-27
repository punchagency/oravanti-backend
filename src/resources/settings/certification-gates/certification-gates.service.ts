import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import {
  paralegalActivationRequirements,
  paralegalCertificationGates,
  paralegalProfiles,
  staffCertifications,
} from "../../../db/schema";

export class CertificationGatesService {
  getCertificationGates = async (firmId: string) => {
    return db
      .select()
      .from(paralegalCertificationGates)
      .where(eq(paralegalCertificationGates.firmId, firmId));
  };

  updateCertificationGates = async (
    firmId: string,
    gates: { action: string; requiredCertifications: string[] }[],
  ) => {
    await Promise.all(
      gates.map((g) =>
        db
          .update(paralegalCertificationGates)
          .set({
            requiredCertifications: g.requiredCertifications,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(paralegalCertificationGates.firmId, firmId),
              eq(paralegalCertificationGates.action, g.action as any),
            ),
          ),
      ),
    );
  };

  getActivationRequirements = async (firmId: string) => {
    return db
      .select()
      .from(paralegalActivationRequirements)
      .where(eq(paralegalActivationRequirements.firmId, firmId));
  };

  updateActivationRequirements = async (
    firmId: string,
    certificationCodes: string[],
  ) => {
    await db
      .delete(paralegalActivationRequirements)
      .where(eq(paralegalActivationRequirements.firmId, firmId));

    if (certificationCodes.length > 0) {
      await db
        .insert(paralegalActivationRequirements)
        .values(
          certificationCodes.map((code) => ({
            firmId,
            certificationCode: code,
          })),
        );
    }

    const allParalegals = await db
      .select()
      .from(paralegalProfiles)
      .where(eq(paralegalProfiles.firmId, firmId));

    await Promise.all(
      allParalegals.map(async (paralegal) => {
        const held = await db
          .select()
          .from(staffCertifications)
          .where(eq(staffCertifications.staffId, paralegal.staffId));

        const heldCodes = held.map((c) => c.certificationCode);
        const meetsAll = certificationCodes.every((req) =>
          heldCodes.includes(req),
        );

        await db
          .update(paralegalProfiles)
          .set({ isCertified: meetsAll, updatedAt: new Date() })
          .where(eq(paralegalProfiles.id, paralegal.id));
      }),
    );

    return { updated: allParalegals.length };
  };
}
