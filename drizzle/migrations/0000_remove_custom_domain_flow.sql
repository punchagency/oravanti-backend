-- Migration: Remove custom domain flow
-- 1. Create new enum type without old values
-- 2. Drop domain columns from organization
-- 3. Reset stuck users

-- Step 1: Create new enum type
ALTER TYPE "onboarding_status" ADD VALUE IF NOT EXISTS 'email_unverified';
ALTER TYPE "onboarding_status" ADD VALUE IF NOT EXISTS 'email_verified';
ALTER TYPE "onboarding_status" ADD VALUE IF NOT EXISTS 'completed';

-- Step 2: Drop domain columns from organization
ALTER TABLE "organization" DROP COLUMN IF EXISTS "domain";
ALTER TABLE "organization" DROP COLUMN IF EXISTS "is_domain_verified";
ALTER TABLE "organization" DROP COLUMN IF EXISTS "verification_token";

-- Step 3: Reset stuck users
UPDATE "user"
SET "onboarding_state" = 'email_unverified'
WHERE "onboarding_state" IN ('domain_verified', 'profile_completed', 'org_created');
