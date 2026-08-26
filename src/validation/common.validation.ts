import { z } from "zod";

const requiredValue = (field: string) =>
  z
    .unknown()
    .refine(
      (value) =>
        value !== undefined &&
        value !== null &&
        (typeof value !== "string" || value.trim() !== ""),
      `${field} is required`,
    );

/**
 * A phone number as typed by a human.
 *
 * Deliberately permissive: this rejects only input that could not be a phone
 * number at all. It does NOT require E.164, because intake forms and staff both
 * type national formats, and rejecting those at the API boundary would lose
 * contact details the firm needs for calling even when SMS is switched off.
 *
 * Normalisation to a dialable number happens at send time in `toE164`
 * (src/utils/phone.ts), where a failure is recorded against the notification as
 * `unparseable_phone` and stays visible in the UI.
 *
 * Exported standalone as well as on `CommonValidation` because the class is
 * instantiated per-module and injected into routers, while `*.validation.ts`
 * schema files compose plain Zod consts.
 */
export const phoneSchema = z
  .string()
  .trim()
  .min(7, "Phone number is too short")
  .max(32, "Phone number is too long")
  .regex(/^[+()\-.\s\d]+$/, "Phone number contains invalid characters");

export class CommonValidation {
  public nonEmptyString = z.string().min(1, "Value is required");
  public uuid = z.string().uuid("Must be a valid UUID");
  public anyObject = z.object({}).passthrough();

  public idParams = z.object({
    id: this.uuid,
  });

  public phone = phoneSchema;

  public paginationQuery = z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
    all: z.string().optional(),
  });

  public searchQuery = this.paginationQuery.extend({
    search: z.string().optional(),
  });

  public params = <T extends string>(...keys: T[]) =>
    z.object(
      Object.fromEntries(keys.map((key) => [key, this.uuid])) as Record<
        T,
        typeof this.uuid
      >,
    );

  public tokenParams = <T extends string>(key: T) =>
    z.object({
      [key]: z.string().min(1, `${key} is required`),
    } as Record<T, z.ZodString>);

  public query = (shape: Record<string, z.ZodType>) =>
    z.object(shape).passthrough();

  public optionalBody = () => this.anyObject;

  public enumValue = <T extends readonly [string, ...string[]]>(values: T) =>
    z.enum(values);

  public requiredBody = <T extends string>(...fields: T[]) =>
    z
      .object(
        Object.fromEntries(
          fields.map((field) => [field, requiredValue(field)]),
        ) as unknown as Record<T, z.ZodType>,
      )
      .passthrough();

  public requiredArrayBody = <T extends string>(...fields: T[]) =>
    z
      .object(
        Object.fromEntries(
          fields.map((field) => [
            field,
            z.array(z.unknown()).min(1, `${field} array is required`),
          ]),
        ) as unknown as Record<T, z.ZodType>,
      )
      .passthrough();

  public arrayBody = <T extends string>(...fields: T[]) =>
    z
      .object(
        Object.fromEntries(
          fields.map((field) => [field, z.array(z.unknown())]),
        ) as unknown as Record<T, z.ZodType>,
      )
      .passthrough();
}
