import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { leadNotes, leads } from "../../db/schema/leads";
import type { LeadNoteType } from "../../db/schema/leads";
import { staff } from "../../db/schema/staff";
import { AuthorizationError, NotFoundError } from "../../utils/error/app-error";
import { logLeadEvent } from "./lead-events.service";

/**
 * Lead notes are append-only. There is no update and no delete — not because
 * one hasn't been written yet, but because a note is a record of what someone
 * said at a point in time. A correction is a new note.
 */

export type LeadNoteEntry = {
  id: string;
  type: LeadNoteType;
  content: string;
  authorId: string;
  authorName: string | null;
  createdAt: Date;
};

export const getLeadNotes = async (
  leadId: string,
  organizationId: string,
): Promise<LeadNoteEntry[]> => {
  const [lead] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)),
    )
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");

  const rows = await db
    .select({
      id: leadNotes.id,
      type: leadNotes.type,
      content: leadNotes.content,
      authorId: leadNotes.authorId,
      firstName: staff.firstName,
      lastName: staff.lastName,
      createdAt: leadNotes.createdAt,
    })
    .from(leadNotes)
    .leftJoin(staff, eq(leadNotes.authorId, staff.id))
    .where(eq(leadNotes.leadId, leadId))
    .orderBy(asc(leadNotes.createdAt));

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    content: r.content,
    authorId: r.authorId,
    authorName: r.firstName ? `${r.firstName} ${r.lastName}`.trim() : null,
    createdAt: r.createdAt,
  }));
};

export const addLeadNote = async (
  leadId: string,
  organizationId: string,
  data: { type?: LeadNoteType; content: string },
  authorId?: string,
): Promise<LeadNoteEntry> => {
  const [lead] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)),
    )
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");

  // A note is attributable by definition — an unattributed note is worthless as
  // a record, so refuse rather than writing one with a null author.
  if (!authorId)
    throw new AuthorizationError(
      "A valid staff profile is required to add a note",
    );

  const [author] = await db
    .select({ firstName: staff.firstName, lastName: staff.lastName })
    .from(staff)
    .where(eq(staff.id, authorId))
    .limit(1);

  if (!author)
    throw new AuthorizationError(
      "A valid staff profile is required to add a note",
    );

  const type = data.type ?? "general";

  const note = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(leadNotes)
      .values({ leadId, authorId, type, content: data.content })
      .returning();

    await logLeadEvent({
      organizationId,
      leadId,
      type: "note_added",
      actorId: authorId,
      metadata: { noteId: created.id, noteType: type },
      tx,
    });

    return created;
  });

  return {
    id: note.id,
    type: note.type,
    content: note.content,
    authorId: note.authorId,
    authorName: `${author.firstName} ${author.lastName}`.trim(),
    createdAt: note.createdAt,
  };
};
