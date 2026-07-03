import crypto from "crypto";
import { eq } from "drizzle-orm";
import { auth } from "../../auth";
import { db } from "../../db/client";
import { organization, user } from "../../db/schema/auth-schema";
import { staff } from "../../db/schema/staff";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";
import type { AccountType } from "../auth/enums";

export class OnboardingService {
  submitOnboardingData = async (
    headers: Headers,
    userId: string,
    body: {
      accountType: AccountType;
      referralSource?: string;
      profile: {
        firstName: string;
        lastName: string;
        phone?: string;
        jobTitle?: string;
      };
      firmDetails: {
        firmName: string;
        firmEmail: string;
        firmPhoneNumber: string;
        address: string;
        city: string;
        state: string;
        zipcode: string;
        website?: string;
        taxId: string;
      };
    },
  ) => {
    const { accountType, referralSource, profile, firmDetails } = body;

    if (accountType !== "firm_admin") {
      throw new BadRequestError(
        "Invalid account type for onboarding submission.",
      );
    }

    const [userRecord] = await db
      .select({ onboardingState: user.onboardingState, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (!userRecord) {
      throw new NotFoundError("User not found.");
    }

    if (userRecord.onboardingState === "completed") {
      throw new ConflictError("Onboarding has already been completed.");
    }

    const corporateSlug = firmDetails.firmName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "");

    const newOrg = await auth.api.createOrganization({
      headers,
      body: {
        name: firmDetails.firmName,
        slug: corporateSlug,
      },
    });

    if (!newOrg) {
      throw new Error("Failed to create organization.");
    }

    await db.transaction(async (tx) => {
      // 1. Create staff profile
      await tx.insert(staff).values({
        id: crypto.randomUUID(),
        organizationId: newOrg.id,
        userId,
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: userRecord.email ?? "",
        role: "admin",
        orgEmail: userRecord.email ?? "",
        startDate: new Date(),
        phone: profile.phone ?? "",
        jobTitle: profile.jobTitle || "Firm Administrator",
        status: "active",
      });

      // 2. Update organization with firm details
      await tx
        .update(organization)
        .set({
          name: firmDetails.firmName,
          slug: corporateSlug,
          emailAddress: firmDetails.firmEmail,
          phoneNumber: firmDetails.firmPhoneNumber,
          address: firmDetails.address,
          city: firmDetails.city,
          state: firmDetails.state,
          zipCode: firmDetails.zipcode,
          website: firmDetails.website,
          taxId: firmDetails.taxId,
          referralSource: referralSource ?? null,
        })
        .where(eq(organization.id, newOrg.id));

      // 3. Accept terms and finalize onboarding
      await tx
        .update(user)
        .set({
          tosAccepted: true,
          tosAcceptedAt: new Date(),
          onboardingState: "completed",
        })
        .where(eq(user.id, userId));
    });

    return { nextStep: "/admin" };
  };
}
