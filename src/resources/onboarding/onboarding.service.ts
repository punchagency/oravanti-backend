import crypto from "crypto";
import dns from "dns/promises";
import { and, eq, ne } from "drizzle-orm";
import { auth } from "../../auth";
import { db } from "../../db/client";
import { member, organization, user } from "../../db/schema/auth-schema";
import { staff } from "../../db/schema/staff";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";
import type { AccountType } from "../auth/enums";

export class OnboardingService {
  constructor() {}

  initiateDomainVerification = async (
    headers: Headers,
    userId: string,
    domainInput: string,
  ) => {
    const cleanDomain = domainInput
      .replace(/^(https?:\/\/)?(www\.)?/, "")
      .replace(/\/$/, "")
      .toLowerCase();

    const verificationToken = `oravanti-app-domain-verify-${crypto.randomBytes(16).toString("hex")}`;
    const temporarySlug = `pending-${crypto.randomBytes(6).toString("hex")}`;

    const [userRecord] = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (!userRecord) {
      throw new NotFoundError("User not found.");
    }

    const emailDomain = userRecord.email.split("@")[1]?.toLowerCase();
    if (!emailDomain || cleanDomain !== emailDomain) {
      throw new BadRequestError(
        "The domain must match the domain of your account email address.",
      );
    }

    const [verifiedOrg] = await db
      .select()
      .from(organization)
      .where(
        and(
          eq(organization.domain, cleanDomain),
          eq(organization.isDomainVerified, true),
        ),
      )
      .limit(1);

    if (verifiedOrg) {
      throw new ConflictError(
        "This corporate domain name has already been registered and verified.",
      );
    }

    const [existingMember] = await db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId))
      .limit(1);

    if (existingMember) {
      const existingOrgId = existingMember.organizationId;
      const [existingOrgRecord] = await db
        .select({ domain: organization.domain })
        .from(organization)
        .where(eq(organization.id, existingOrgId))
        .limit(1);

      if (existingOrgRecord?.domain === cleanDomain) {
        await db
          .update(organization)
          .set({ verificationToken, isDomainVerified: false })
          .where(eq(organization.id, existingOrgId));

        return {
          organizationId: existingOrgId,
          txtRecordName: "@",
          txtRecordValue: verificationToken,
        };
      }

      await auth.api.deleteOrganization({
        body: { organizationId: existingOrgId },
        headers,
      });
    }

    const newOrg = await auth.api.createOrganization({
      headers,
      body: {
        name: "Pending Verification",
        slug: temporarySlug,
      },
    });

    if (!newOrg) {
      throw new Error("Failed to initialize system organization workspace.");
    }

    await db
      .update(organization)
      .set({
        domain: cleanDomain,
        verificationToken,
        isDomainVerified: false,
      })
      .where(eq(organization.id, newOrg.id));

    return {
      organizationId: newOrg.id,
      txtRecordName: "@",
      txtRecordValue: verificationToken,
    };
  };

  verifyDomainDnsLive = async (userId: string, orgId: string) => {
    const [org] = await db
      .select()
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);

    if (!org || !org.domain || !org.verificationToken) {
      throw new NotFoundError(
        "Target organization verification context not found.",
      );
    }

    const [verifiedOrg] = await db
      .select()
      .from(organization)
      .where(
        and(
          eq(organization.domain, org.domain),
          eq(organization.isDomainVerified, true),
          ne(organization.id, orgId),
        ),
      )
      .limit(1);

    if (verifiedOrg) {
      throw new ConflictError(
        "This domain has already been verified by another organization.",
      );
    }

    try {
      const lookupRecords = await dns.resolveTxt(org.domain);
      const isTokenPresent = lookupRecords
        .flat()
        .includes(org.verificationToken);

      if (!isTokenPresent) {
        return {
          success: false,
          message:
            "TXT verification token could not be detected. Please allow a few moments for global DNS propagation.",
        };
      }

      await db.transaction(async (tx) => {
        await tx
          .update(organization)
          .set({ isDomainVerified: true, verificationToken: null })
          .where(eq(organization.id, orgId));

        await tx
          .update(user)
          .set({ onboardingState: "domain_verified" })
          .where(eq(user.id, userId));
      });

      return { success: true, nextStep: "/onboarding/step-2-profile" };
    } catch (error) {
      return {
        success: false,
        message:
          "Unable to resolve target domain DNS records. Double-check your entry spelling.",
      };
    }
  };

  submitOnboardingData = async (
    userId: string,
    body: {
      accountType: AccountType;
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
      organizationId: string;
    },
  ) => {
    const { accountType, profile, firmDetails, organizationId } = body;

    if (accountType !== "firm_admin") {
      throw new BadRequestError(
        "Invalid account type for onboarding submission.",
      );
    }

    const [org] = await db
      .select({ id: organization.id, domain: organization.domain })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);

    if (!org) {
      throw new NotFoundError("Organization not found.");
    }

    const emailDomain = firmDetails.firmEmail.split("@")[1]?.toLowerCase();
    if (!emailDomain || emailDomain !== org.domain) {
      throw new BadRequestError(
        "The firm email address domain must match your verified corporate domain.",
      );
    }

    const [userRecord] = await db
      .select({ onboardingState: user.onboardingState })
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

    await db.transaction(async (tx) => {
      // 1. Create staff profile
      const [existingStaff] = await tx
        .select({ id: staff.id })
        .from(staff)
        .where(eq(staff.userId, userId))
        .limit(1);

      if (!existingStaff) {
        await tx.insert(staff).values({
          id: crypto.randomUUID(),
          organizationId,
          userId,
          firstName: profile.firstName,
          lastName: profile.lastName,
          phone: profile.phone ?? "",
          jobTitle: profile.jobTitle || "Firm Administrator",
          status: "active",
        });
      }

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
        })
        .where(eq(organization.id, organizationId));

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
