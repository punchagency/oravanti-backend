import { pgEnum } from "drizzle-orm/pg-core";

// 1. Account Types Domain Configuration
export const accountTypeValues = [
  "firm_admin",
  "contractor",
  "client",
] as const;
export type AccountType = (typeof accountTypeValues)[number];
export const accountTypeEnum = pgEnum("account_type_enum", accountTypeValues);

// 2. Onboarding Lifecycle States
export const onboardingStateValues = [
  "email_unverified",
  "completed",
] as const;
export type OnboardingState = (typeof onboardingStateValues)[number];
export const onboardingStateEnum = pgEnum(
  "onboarding_state_enum",
  onboardingStateValues,
);

// 3. Operational Staff Clearances
export const staffStatusValues = ["active", "inactive", "suspended"] as const;
export type StaffStatus = (typeof staffStatusValues)[number];
export const staffStatusEnum = pgEnum("staff_status_enum", staffStatusValues);
