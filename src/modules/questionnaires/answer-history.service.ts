import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { withTransaction } from "../../db/transaction-context";
import { staff } from "../../db/schema/staff";
import {
  questionnaireAnswerRevisions,
  questionnaireAnswers,
  questionnaireQuestions,
  questionnaireResponses,
  questionnaireResponseVersions,
  questionnaireSections,
} from "../../db/schema/questionnaires";
import { NotFoundError } from "../../utils/error/app-error";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";

const log = createModuleLogger("questionnaires.answer_history");

type JsonObject = Record<string, unknown>;

export type AnswerActor = "staff" | "client";
export type AnswerInput = { questionId: string; value: unknown };

/**
 * The one place an answer is ever written.
 *
 * Staff saving a section and a client pressing "Save progress" are the same
 * operation seen from two sides, and they used to be two code paths that
 * disagreed about what a save meant. Both now come here, which is what makes
 * the history complete: a version exists because a save happened, not because
 * somebody remembered to record one.
 *
 * A save does four things, in this order and for these reasons:
 *
 *   1. Diffs against what is stored, so an untouched field writes nothing. A
 *      version listing "6 answers changed" has to mean six.
 *   2. Applies the changes.
 *   3. Writes one version (the full snapshot, for restore) and one revision per
 *      changed answer (for that answer's timeline).
 *   4. Leaves form population to the caller — it must happen outside this
 *      transaction, because filling a form is a consequence of the save and
 *      must never be able to roll one back.
 */
export async function commitAnswers(params: {
  organizationId: string;
  responseId: string;
  answers: AnswerInput[];
  actor: AnswerActor;
  /** The staff member, when `actor` is `staff`. */
  actorId?: string;
  /** The section saved, when the save came from one. */
  sectionId?: string | null;
  /** Set when this save is itself a restore. */
  restoredFromVersionId?: string | null;
}) {
  const {
    organizationId,
    responseId,
    answers,
    actor,
    actorId,
    sectionId,
    restoredFromVersionId,
  } = params;

  return withTransaction(db, async () => {
    const stored = await db
      .select({
        questionId: questionnaireAnswers.questionId,
        value: questionnaireAnswers.value,
      })
      .from(questionnaireAnswers)
      .where(eq(questionnaireAnswers.responseId, responseId));

    const current = new Map<string, unknown>(
      stored.map((row) => [row.questionId, row.value]),
    );

    // An emptied answer is a deletion, not a stored null: the form resolver
    // reads "no row" as "nothing to copy", and a null would blank the field it
    // feeds instead of leaving it alone.
    const changes: {
      questionId: string;
      previousValue: unknown;
      value: unknown;
    }[] = [];

    for (const answer of answers) {
      const next = isEmpty(answer.value) ? null : answer.value;
      const previous = current.has(answer.questionId)
        ? (current.get(answer.questionId) ?? null)
        : null;

      if (sameValue(previous, next)) continue;
      changes.push({ questionId: answer.questionId, previousValue: previous, value: next });
    }

    if (changes.length === 0) {
      return { changed: 0, version: null };
    }

    const now = new Date();

    for (const change of changes) {
      if (change.value === null) {
        await db
          .delete(questionnaireAnswers)
          .where(
            and(
              eq(questionnaireAnswers.responseId, responseId),
              eq(questionnaireAnswers.questionId, change.questionId),
            ),
          );
        current.delete(change.questionId);
        continue;
      }

      await db
        .insert(questionnaireAnswers)
        .values({
          responseId,
          organizationId,
          questionId: change.questionId,
          value: change.value as JsonObject,
        })
        .onConflictDoUpdate({
          target: [
            questionnaireAnswers.responseId,
            questionnaireAnswers.questionId,
          ],
          set: { value: change.value as JsonObject, updatedAt: now },
        });
      current.set(change.questionId, change.value);
    }

    // Numbered per response so staff can say "version 4" and mean something.
    // Read inside the transaction, so two concurrent saves cannot both claim
    // the same number — the unique index would reject the second anyway, and
    // this is what stops it getting there.
    const [{ highest }] = await db
      .select({
        highest: sql<number>`coalesce(max(${questionnaireResponseVersions.versionNumber}), 0)`,
      })
      .from(questionnaireResponseVersions)
      .where(eq(questionnaireResponseVersions.responseId, responseId));

    const [version] = await db
      .insert(questionnaireResponseVersions)
      .values({
        organizationId,
        responseId,
        versionNumber: Number(highest) + 1,
        actor,
        savedById: actor === "staff" ? actorId : undefined,
        answers: Object.fromEntries(current) as JsonObject,
        changedCount: changes.length,
        sectionId: sectionId ?? null,
        restoredFromVersionId: restoredFromVersionId ?? null,
      })
      .returning();

    await db.insert(questionnaireAnswerRevisions).values(
      changes.map((change) => ({
        organizationId,
        responseId,
        versionId: version.id,
        questionId: change.questionId,
        previousValue: change.previousValue as JsonObject | null,
        value: change.value as JsonObject | null,
        actor,
        changedById: actor === "staff" ? actorId : undefined,
      })),
    );

    await db
      .update(questionnaireResponses)
      .set({ lastSavedAt: now, updatedAt: now })
      .where(eq(questionnaireResponses.id, responseId));

    log.action(LogEvent.QUESTIONNAIRE_ANSWERS_SAVED, {
      responseId,
      versionNumber: version.versionNumber,
      changed: changes.length,
      actor,
    });

    return { changed: changes.length, version };
  });
}

/**
 * The saves made against a response, newest first.
 *
 * The snapshot itself is deliberately not returned — it is one blob per row and
 * the list only needs to say who saved what and when. `getVersion` fetches one.
 */
export async function listVersions(
  organizationId: string,
  responseId: string,
) {
  const rows = await db
    .select({
      id: questionnaireResponseVersions.id,
      versionNumber: questionnaireResponseVersions.versionNumber,
      actor: questionnaireResponseVersions.actor,
      changedCount: questionnaireResponseVersions.changedCount,
      createdAt: questionnaireResponseVersions.createdAt,
      restoredFromVersionId:
        questionnaireResponseVersions.restoredFromVersionId,
      sectionTitle: questionnaireSections.title,
      firstName: staff.firstName,
      lastName: staff.lastName,
    })
    .from(questionnaireResponseVersions)
    .leftJoin(staff, eq(staff.id, questionnaireResponseVersions.savedById))
    .leftJoin(
      questionnaireSections,
      eq(questionnaireSections.id, questionnaireResponseVersions.sectionId),
    )
    .where(
      and(
        eq(questionnaireResponseVersions.responseId, responseId),
        eq(questionnaireResponseVersions.organizationId, organizationId),
      ),
    )
    .orderBy(desc(questionnaireResponseVersions.versionNumber));

  return rows.map(({ firstName, lastName, ...row }) => ({
    ...row,
    savedBy: fullName(firstName, lastName),
  }));
}

/**
 * Who to credit a save to.
 *
 * A client save has no staff row behind it, so the name is null and the caller
 * shows the client's own attribution instead — which reads better than the
 * client's name would anyway: "the client" is the fact that matters.
 */
function fullName(first: string | null, last: string | null) {
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : null;
}

/** One version with its snapshot and the answers it changed. */
export async function getVersion(organizationId: string, versionId: string) {
  const [version] = await db
    .select()
    .from(questionnaireResponseVersions)
    .where(
      and(
        eq(questionnaireResponseVersions.id, versionId),
        eq(questionnaireResponseVersions.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!version) throw new NotFoundError("Version not found");

  const changes = await db
    .select({
      questionId: questionnaireAnswerRevisions.questionId,
      previousValue: questionnaireAnswerRevisions.previousValue,
      value: questionnaireAnswerRevisions.value,
      label: questionnaireQuestions.label,
    })
    .from(questionnaireAnswerRevisions)
    .leftJoin(
      questionnaireQuestions,
      eq(questionnaireQuestions.id, questionnaireAnswerRevisions.questionId),
    )
    .where(eq(questionnaireAnswerRevisions.versionId, versionId));

  return { ...version, changes };
}

/**
 * One answer's timeline, newest first.
 *
 * Scoped by response as well as question so a question shared across matters —
 * every seeded one is — cannot leak another matter's answers.
 */
export async function listAnswerRevisions(
  organizationId: string,
  responseId: string,
  questionId: string,
) {
  const rows = await db
    .select({
      id: questionnaireAnswerRevisions.id,
      previousValue: questionnaireAnswerRevisions.previousValue,
      value: questionnaireAnswerRevisions.value,
      actor: questionnaireAnswerRevisions.actor,
      createdAt: questionnaireAnswerRevisions.createdAt,
      versionNumber: questionnaireResponseVersions.versionNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
    })
    .from(questionnaireAnswerRevisions)
    .innerJoin(
      questionnaireResponseVersions,
      eq(questionnaireResponseVersions.id, questionnaireAnswerRevisions.versionId),
    )
    .leftJoin(staff, eq(staff.id, questionnaireAnswerRevisions.changedById))
    .where(
      and(
        eq(questionnaireAnswerRevisions.responseId, responseId),
        eq(questionnaireAnswerRevisions.questionId, questionId),
        eq(questionnaireAnswerRevisions.organizationId, organizationId),
      ),
    )
    .orderBy(desc(questionnaireAnswerRevisions.createdAt));

  return rows.map(({ firstName, lastName, ...row }) => ({
    ...row,
    changedBy: fullName(firstName, lastName),
  }));
}

/**
 * The answers a version held, restricted to questions that still exist.
 *
 * A question deleted since the save has nothing to restore into, and writing
 * its answer back would leave a row whose foreign key no longer resolves.
 */
export async function answersFromVersion(
  organizationId: string,
  versionId: string,
) {
  const version = await getVersion(organizationId, versionId);
  const snapshot = version.answers as Record<string, unknown>;
  const questionIds = Object.keys(snapshot);

  if (questionIds.length === 0) return { version, answers: [] };

  const live = await db
    .select({ id: questionnaireQuestions.id })
    .from(questionnaireQuestions)
    .where(inArray(questionnaireQuestions.id, questionIds));

  const liveIds = new Set(live.map((q) => q.id));

  return {
    version,
    answers: questionIds
      .filter((id) => liveIds.has(id))
      .map((questionId) => ({ questionId, value: snapshot[questionId] })),
  };
}

/**
 * The first version of a response, used to seed history for answers that
 * predate it — see the backfill in `consolidate-case-responses.sql`.
 */
export async function earliestVersion(responseId: string) {
  const [version] = await db
    .select()
    .from(questionnaireResponseVersions)
    .where(eq(questionnaireResponseVersions.responseId, responseId))
    .orderBy(asc(questionnaireResponseVersions.versionNumber))
    .limit(1);
  return version;
}

const isEmpty = (value: unknown) => {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

/**
 * Whether two answers are the same.
 *
 * Compared as JSON rather than by reference: an answer is `jsonb`, so a
 * multi-select comes back as a fresh array on every read and `===` would call
 * every unchanged checkbox a change.
 */
const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
