import { z } from "zod";

/**
 * Request schemas for the practice-areas subscription endpoints.
 *
 * Replaces `CommonValidation.optionalBody()`. The service already validated
 * `billingCycle` and the date fields at runtime via `assertBillingCycle` and
 * `parseOptionalDate` — this moves those checks to the edge, where the error
 * names the offending field, and rejects unknown keys on the way in.
 */

const uuid = z.string().uuid();

/** Mirrors `BILLING_CYCLES` in practice-areas.service.ts. */
export const billingCycle = z.enum(["monthly", "annual"]);

/** ISO-8601 instant; the service parses these with `new Date(value)`. */
const isoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "Expected an ISO-8601 date");

const subscriptionItem = z
  .object({
    practiceAreaId: uuid,
    billingCycle: billingCycle.optional(),
    startsAt: isoDateTime.optional(),
    expiresAt: isoDateTime.nullable().optional(),
    paymentProvider: z.string().trim().min(1).max(60).optional(),
    providerSubscriptionId: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

/**
 * Two accepted shapes, matching `normalizeSubscriptionInputs`: either a list of
 * per-area `subscriptions`, or a flat `practiceAreaIds` list with the billing
 * terms applied to all of them. Requiring exactly one avoids the ambiguity of
 * both being present.
 */
export const createSubscriptionsBody = z
  .object({
    subscriptions: z.array(subscriptionItem).min(1).max(100).optional(),
    practiceAreaIds: z.array(uuid).min(1).max(100).optional(),
    billingCycle: billingCycle.optional(),
    startsAt: isoDateTime.optional(),
    expiresAt: isoDateTime.nullable().optional(),
    paymentProvider: z.string().trim().min(1).max(60).optional(),
    providerSubscriptionId: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .refine(
    (b) => Boolean(b.subscriptions?.length) !== Boolean(b.practiceAreaIds?.length),
    { message: "Provide either subscriptions or practiceAreaIds, not both" },
  );

/** The service rejects both lists together; the schema says so up front. */
export const cancelSubscriptionsBody = z
  .object({
    subscriptionIds: z.array(uuid).min(1).max(100).optional(),
    practiceAreaIds: z.array(uuid).min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (b) => Boolean(b.subscriptionIds?.length) !== Boolean(b.practiceAreaIds?.length),
    { message: "Provide either subscriptionIds or practiceAreaIds, not both" },
  );

export type CreateSubscriptionsInput = z.infer<typeof createSubscriptionsBody>;
export type CancelSubscriptionsInput = z.infer<typeof cancelSubscriptionsBody>;
