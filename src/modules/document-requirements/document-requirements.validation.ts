import { z } from "zod";
import { DOCUMENT_TYPE_SLUGS } from "../ai-scan/vocabulary";

const slug = z
  .string()
  .refine((s) => (DOCUMENT_TYPE_SLUGS as readonly string[]).includes(s), {
    message: "Unknown document type slug",
  });

const anchor = z.enum([
  "uscis_interview",
  "filing_deadline",
  "next_court_date",
  "case_opened",
]);

export const listQuerySchema = z.object({
  caseTypeId: z.string().uuid(),
});

export const createBodySchema = z.object({
  caseTypeId: z.string().uuid(),
  label: z.string().min(1).max(200),
  documentTypeSlug: slug.optional(),
  isRequired: z.boolean().optional(),
  orderIndex: z.number().int().min(0).optional(),
  dueDateOffsetDays: z.number().int().optional(),
  dueDateAnchor: anchor.optional(),
});

export const updateBodySchema = z
  .object({
    label: z.string().min(1).max(200).optional(),
    documentTypeSlug: slug.nullable().optional(),
    isRequired: z.boolean().optional(),
    orderIndex: z.number().int().min(0).optional(),
    dueDateOffsetDays: z.number().int().nullable().optional(),
    dueDateAnchor: anchor.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required",
  });
