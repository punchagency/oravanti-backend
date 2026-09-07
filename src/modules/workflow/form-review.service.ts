/**
 * The lead attorney's review of a filing package.
 *
 * ─── The process this encodes ──────────────────────────────────────────────
 *
 * The team prepares the package, somebody sends it up, the reviewing attorney
 * reads it and marks whatever is wrong — a whole part of a form, or one field —
 * in a colour, with a sentence saying what is wrong. Each mark is a
 * *correction*: it has to be answered, and answering it means writing what was
 * changed. When nothing is open, the attorney approves, and only then may a
 * form be marked ready to file.
 *
 * ─── Two rules hold the whole thing up ─────────────────────────────────────
 *
 * **Raising a correction sets the package to `changes_requested`.** Not a
 * separate button the attorney also has to press: a status somebody must
 * remember to set is a status that disagrees with the marks by the end of the
 * week. Approving is the only state change a person chooses on purpose, which
 * is right, because it is the only one that is a judgement.
 *
 * **Approval is spent by the next correction.** Reopening a resolved mark, or
 * raising a new one, drops the package out of `approved` and clears the
 * sign-off. An approval that survived a later correction would be a signature
 * on a document that has changed since — which is the one thing a sign-off must
 * never be.
 */
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { caseForms } from "../../db/schema/case-forms";
import {
  caseFormCorrectionComments,
  caseFormCorrections,
  type CaseFormCorrectionColor,
} from "../../db/schema/case-form-corrections";
import { cases } from "../../db/schema/cases";
import { staff } from "../../db/schema/staff";
import { getRequestContext } from "../../middleware/request-context";
import {
  AuthorizationError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";
import { recordAuditEvent } from "../shared/audit.service";
import { isActorAnAttorney } from "../case-review/assignees";

/** The matter, scoped to the firm — so every call below doubles as an access check. */
const requireCase = async (caseId: string, organizationId: string) => {
  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      filingReviewStatus: cases.filingReviewStatus,
      filingApprovedById: cases.filingApprovedById,
      filingApprovedAt: cases.filingApprovedAt,
    })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);

  if (!row) throw new NotFoundError("Case not found");
  return row;
};

/** The acting staff member, or a 403 — every write here is signed. */
const requireActor = () => {
  const { staffId } = getRequestContext();
  if (!staffId) {
    throw new AuthorizationError(
      "Only a member of the firm's staff can review a filing package",
    );
  }
  return staffId;
};

const requireAttorney = async (action: string) => {
  const staffId = requireActor();
  if (!(await isActorAnAttorney(staffId))) {
    throw new AuthorizationError(`Only an attorney can ${action}`);
  }
  return staffId;
};

/** How many corrections are still open on the matter. The gate reads this. */
export const openCorrectionCount = async (caseId: string) => {
  const [row] = await db
    .select({ n: count() })
    .from(caseFormCorrections)
    .where(
      and(
        eq(caseFormCorrections.caseId, caseId),
        eq(caseFormCorrections.status, "open"),
      ),
    );
  return row?.n ?? 0;
};

/**
 * The gate on `ready_to_file`, called by `updateCaseForm`.
 *
 * One sentence of refusal rather than a boolean, because the caller's job is to
 * put it in front of the person who pressed the button, and "not allowed" is
 * not an answer anybody can act on.
 */
export const readyToFileRefusal = async (
  caseId: string,
): Promise<string | null> => {
  const [row] = await db
    .select({ filingReviewStatus: cases.filingReviewStatus })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);

  if (row?.filingReviewStatus === "approved") return null;

  const open = await openCorrectionCount(caseId);
  if (open > 0) {
    return `The reviewing attorney has ${open} correction${open === 1 ? "" : "s"} open on this filing. Resolve them, then have the filing approved.`;
  }
  return "This filing has not been approved by an attorney yet.";
};

/**
 * Move the package's review state, and say so in the timeline.
 *
 * Private because every transition here is a consequence of something else — a
 * mark raised, a mark reopened, an approval given. Nothing sets the status for
 * its own sake.
 */
const setReviewStatus = async (params: {
  caseId: string;
  organizationId: string;
  status: "in_preparation" | "in_review" | "changes_requested" | "approved";
  approvedById?: string | null;
}) => {
  const approved = params.status === "approved";
  await db
    .update(cases)
    .set({
      filingReviewStatus: params.status,
      filingApprovedById: approved ? (params.approvedById ?? null) : null,
      filingApprovedAt: approved ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(cases.id, params.caseId));
};

// ─── Reading the review ─────────────────────────────────────────────────────

export type CorrectionView = Awaited<
  ReturnType<typeof listCorrections>
>[number];

/**
 * Every correction on the matter, newest first, with its thread.
 *
 * The whole package in one call rather than per form: the Forms tab's first
 * question is "what is still open on this filing", and asking it six times
 * would make the answer depend on which form happened to be selected.
 */
export const listCorrections = async (
  caseId: string,
  organizationId: string,
) => {
  const rows = await db
    .select({
      id: caseFormCorrections.id,
      caseFormId: caseFormCorrections.caseFormId,
      formCode: caseForms.formCode,
      partLabel: caseFormCorrections.partLabel,
      fieldKey: caseFormCorrections.fieldKey,
      color: caseFormCorrections.color,
      note: caseFormCorrections.note,
      status: caseFormCorrections.status,
      raisedById: caseFormCorrections.raisedById,
      raisedAt: caseFormCorrections.raisedAt,
      resolvedById: caseFormCorrections.resolvedById,
      resolvedAt: caseFormCorrections.resolvedAt,
    })
    .from(caseFormCorrections)
    .innerJoin(caseForms, eq(caseForms.id, caseFormCorrections.caseFormId))
    .where(
      and(
        eq(caseFormCorrections.caseId, caseId),
        eq(caseFormCorrections.organizationId, organizationId),
      ),
    )
    .orderBy(desc(caseFormCorrections.raisedAt));

  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  const [comments, people] = await Promise.all([
    db
      .select({
        id: caseFormCorrectionComments.id,
        correctionId: caseFormCorrectionComments.correctionId,
        authorId: caseFormCorrectionComments.authorId,
        body: caseFormCorrectionComments.body,
        createdAt: caseFormCorrectionComments.createdAt,
      })
      .from(caseFormCorrectionComments)
      .where(inArray(caseFormCorrectionComments.correctionId, ids))
      .orderBy(caseFormCorrectionComments.createdAt),
    namesFor(rows.flatMap((r) => [r.raisedById, r.resolvedById])),
  ]);

  const authorIds = comments.map((c) => c.authorId);
  const commentNames = await namesFor(authorIds);

  const threads = new Map<string, typeof comments>();
  for (const comment of comments) {
    const thread = threads.get(comment.correctionId) ?? [];
    thread.push(comment);
    threads.set(comment.correctionId, thread);
  }

  return rows.map((row) => ({
    ...row,
    raisedByName: people.get(row.raisedById) ?? null,
    resolvedByName: row.resolvedById
      ? (people.get(row.resolvedById) ?? null)
      : null,
    comments: (threads.get(row.id) ?? []).map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      authorId: comment.authorId,
      authorName: commentNames.get(comment.authorId) ?? null,
    })),
  }));
};

/** Staff display names, by id. One query for however many ids the page needs. */
const namesFor = async (staffIds: (string | null)[]) => {
  const ids = [...new Set(staffIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map<string, string>();

  const rows = await db
    .select({
      id: staff.id,
      firstName: staff.firstName,
      lastName: staff.lastName,
    })
    .from(staff)
    .where(inArray(staff.id, ids));

  return new Map(
    rows.map((row) => [
      row.id,
      [row.firstName, row.lastName].filter(Boolean).join(" ").trim(),
    ]),
  );
};

/** The matter's review: its state, who signed it off, and every mark on it. */
export const getFilingReview = async (
  caseId: string,
  organizationId: string,
) => {
  const caseRow = await requireCase(caseId, organizationId);
  const [corrections, approver] = await Promise.all([
    listCorrections(caseId, organizationId),
    namesFor([caseRow.filingApprovedById]),
  ]);

  return {
    status: caseRow.filingReviewStatus,
    approvedAt: caseRow.filingApprovedAt,
    approvedByName: caseRow.filingApprovedById
      ? (approver.get(caseRow.filingApprovedById) ?? null)
      : null,
    openCount: corrections.filter((c) => c.status === "open").length,
    corrections,
    /** Whether the person asking may mark, approve and reopen. Drives the UI. */
    canReview: await isActorAnAttorney(getRequestContext().staffId),
  };
};

// ─── Writing ────────────────────────────────────────────────────────────────

/** Send the package up for review. Anyone on the matter may do this. */
export const requestReview = async (caseId: string, organizationId: string) => {
  const caseRow = await requireCase(caseId, organizationId);
  requireActor();

  if (caseRow.filingReviewStatus === "in_review")
    return { status: "in_review" as const };

  await setReviewStatus({ caseId, organizationId, status: "in_review" });

  await recordAuditEvent({
    action: "case.filing_review_requested",
    entityType: "case",
    entityId: caseId,
    organizationId,
    summary: `Filing package on ${caseRow.caseNumber} sent for attorney review`,
    metadata: { previousStatus: caseRow.filingReviewStatus },
  });

  return { status: "in_review" as const };
};

/**
 * Approve the package.
 *
 * Refuses while anything is open, and says how many — an approval given over
 * unanswered marks is the failure this whole feature exists to prevent.
 */
export const approveFiling = async (caseId: string, organizationId: string) => {
  const caseRow = await requireCase(caseId, organizationId);
  const staffId = await requireAttorney("approve a filing package");

  const open = await openCorrectionCount(caseId);
  if (open > 0) {
    throw new ConflictError(
      `${open} correction${open === 1 ? " is" : "s are"} still open on this filing. Every one has to be answered before it can be approved.`,
    );
  }

  await setReviewStatus({
    caseId,
    organizationId,
    status: "approved",
    approvedById: staffId,
  });

  await recordAuditEvent({
    action: "case.filing_review_approved",
    entityType: "case",
    entityId: caseId,
    organizationId,
    summary: `Filing package on ${caseRow.caseNumber} approved`,
    metadata: { previousStatus: caseRow.filingReviewStatus },
  });

  return { status: "approved" as const };
};

/** The form the mark is being put on, scoped to the matter and the firm. */
const requireCaseForm = async (params: {
  caseId: string;
  caseFormId: string;
  organizationId: string;
}) => {
  const [row] = await db
    .select({ id: caseForms.id, formCode: caseForms.formCode })
    .from(caseForms)
    .where(
      and(
        eq(caseForms.id, params.caseFormId),
        eq(caseForms.caseId, params.caseId),
        eq(caseForms.organizationId, params.organizationId),
      ),
    )
    .limit(1);

  if (!row) throw new NotFoundError("That form is not on this matter");
  return row;
};

export const raiseCorrection = async (params: {
  caseId: string;
  organizationId: string;
  caseFormId: string;
  partLabel?: string | null;
  fieldKey?: string | null;
  color?: CaseFormCorrectionColor;
  note: string;
}) => {
  const caseRow = await requireCase(params.caseId, params.organizationId);
  const staffId = await requireAttorney("mark a filing for correction");
  const form = await requireCaseForm(params);

  // The check constraint says the same thing; this is the sentence a person
  // reads instead of a constraint name.
  const anchoredToPart = Boolean(params.partLabel);
  const anchoredToField = Boolean(params.fieldKey);
  if (anchoredToPart === anchoredToField) {
    throw new BadRequestError(
      "A correction marks either one part of the form or one field of it — not both, and not neither.",
    );
  }

  const [created] = await db
    .insert(caseFormCorrections)
    .values({
      organizationId: params.organizationId,
      caseId: params.caseId,
      caseFormId: params.caseFormId,
      partLabel: params.partLabel ?? null,
      fieldKey: params.fieldKey ?? null,
      color: params.color ?? "red",
      note: params.note,
      raisedById: staffId,
    })
    .returning();

  // The mark *is* the request for changes. See the file docblock.
  if (caseRow.filingReviewStatus !== "changes_requested") {
    await setReviewStatus({
      caseId: params.caseId,
      organizationId: params.organizationId,
      status: "changes_requested",
    });
  }

  const where = params.fieldKey ?? params.partLabel;
  await recordAuditEvent({
    action: "case.form_correction_raised",
    entityType: "case_form_correction",
    entityId: created.id,
    parentEntityType: "case",
    parentEntityId: params.caseId,
    organizationId: params.organizationId,
    summary: `${form.formCode} on ${caseRow.caseNumber}: correction raised on ${where}`,
    metadata: {
      formCode: form.formCode,
      partLabel: params.partLabel ?? null,
      fieldKey: params.fieldKey ?? null,
      color: created.color,
    },
  });

  return created;
};

const requireCorrection = async (id: string, organizationId: string) => {
  const [row] = await db
    .select({
      id: caseFormCorrections.id,
      caseId: caseFormCorrections.caseId,
      status: caseFormCorrections.status,
      partLabel: caseFormCorrections.partLabel,
      fieldKey: caseFormCorrections.fieldKey,
      formCode: caseForms.formCode,
    })
    .from(caseFormCorrections)
    .innerJoin(caseForms, eq(caseForms.id, caseFormCorrections.caseFormId))
    .where(
      and(
        eq(caseFormCorrections.id, id),
        eq(caseFormCorrections.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!row) throw new NotFoundError("Correction not found");
  return row;
};

/**
 * Answer a correction: say what was changed, and close it.
 *
 * Anyone on the matter may do this — the person who fixed it is the person who
 * knows what they did. The attorney sees the note on their next pass and
 * reopens it if the answer does not satisfy them.
 *
 * The note is required. "Resolved" with no sentence is the state this table
 * exists to prevent.
 */
export const resolveCorrection = async (params: {
  correctionId: string;
  organizationId: string;
  note: string;
}) => {
  const correction = await requireCorrection(
    params.correctionId,
    params.organizationId,
  );
  const staffId = requireActor();

  if (correction.status === "resolved") {
    throw new ConflictError("That correction is already resolved");
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(caseFormCorrectionComments).values({
      correctionId: correction.id,
      authorId: staffId,
      body: params.note,
    });
    await tx
      .update(caseFormCorrections)
      .set({
        status: "resolved",
        resolvedById: staffId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(caseFormCorrections.id, correction.id));
  });

  await recordAuditEvent({
    action: "case.form_correction_resolved",
    entityType: "case_form_correction",
    entityId: correction.id,
    parentEntityType: "case",
    parentEntityId: correction.caseId,
    organizationId: params.organizationId,
    summary: `${correction.formCode}: correction on ${correction.fieldKey ?? correction.partLabel} resolved`,
    metadata: { note: params.note },
  });

  return { status: "resolved" as const };
};

/**
 * Reopen a correction the attorney is not satisfied with.
 *
 * Attorney-only, and it spends any approval: the package drops back to
 * `changes_requested` because something on it is wrong again.
 */
export const reopenCorrection = async (params: {
  correctionId: string;
  organizationId: string;
  note: string;
}) => {
  const correction = await requireCorrection(
    params.correctionId,
    params.organizationId,
  );
  await requireAttorney("reopen a correction");
  const staffId = requireActor();

  if (correction.status === "open") {
    throw new ConflictError("That correction is already open");
  }

  await db.transaction(async (tx) => {
    await tx.insert(caseFormCorrectionComments).values({
      correctionId: correction.id,
      authorId: staffId,
      body: params.note,
    });
    await tx
      .update(caseFormCorrections)
      .set({
        status: "open",
        resolvedById: null,
        resolvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(caseFormCorrections.id, correction.id));
  });

  await setReviewStatus({
    caseId: correction.caseId,
    organizationId: params.organizationId,
    status: "changes_requested",
  });

  await recordAuditEvent({
    action: "case.form_correction_reopened",
    entityType: "case_form_correction",
    entityId: correction.id,
    parentEntityType: "case",
    parentEntityId: correction.caseId,
    organizationId: params.organizationId,
    summary: `${correction.formCode}: correction on ${correction.fieldKey ?? correction.partLabel} reopened`,
    metadata: { note: params.note },
  });

  return { status: "open" as const };
};

/** Add to the thread without changing the mark's state. */
export const commentOnCorrection = async (params: {
  correctionId: string;
  organizationId: string;
  body: string;
}) => {
  const correction = await requireCorrection(
    params.correctionId,
    params.organizationId,
  );
  const staffId = requireActor();

  const [created] = await db
    .insert(caseFormCorrectionComments)
    .values({
      correctionId: correction.id,
      authorId: staffId,
      body: params.body,
    })
    .returning();

  await recordAuditEvent({
    action: "case.form_correction_commented",
    entityType: "case_form_correction",
    entityId: correction.id,
    parentEntityType: "case",
    parentEntityId: correction.caseId,
    organizationId: params.organizationId,
    summary: `${correction.formCode}: comment on the correction to ${correction.fieldKey ?? correction.partLabel}`,
    metadata: {},
  });

  return created;
};
