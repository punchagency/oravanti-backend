import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { leadNotes, leads } from "../../db/schema/leads";
import type { LeadNoteType } from "../../db/schema/leads";
import { staff } from "../../db/schema/staff";
import { AuthorizationError, NotFoundError } from "../../utils/error/app-error";
import { logLeadEvent } from "./lead-events.service";

/**
 * Lead notes: records of what someone said at a point in time.
 *
 * - Reading: returns notes with author name and role.
 * - Creating: requires a valid staff author; logs a note_added event.
 * - Updating: only the original author may change content/type; logs note_updated.
 * - Deleting: only the original author may delete; logs note_deleted.
 */

export type LeadNoteEntry = {
  id: string;
  type: LeadNoteType;
  content: string;
  authorId: string;
  authorName: string | null;
  authorRole: string | null;
  createdAt: Date;
  updatedAt: Date;
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
      authorRole: staff.role,
      createdAt: leadNotes.createdAt,
      updatedAt: leadNotes.updatedAt,
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
    authorRole: r.authorRole,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
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
    authorRole: null,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
};

export const updateLeadNote = async (
  noteId: string,
  leadId: string,
  organizationId: string,
  data: { content?: string; type?: LeadNoteType },
  actorId: string,
): Promise<LeadNoteEntry> => {
  const [existing] = await db
    .select({
      id: leadNotes.id,
      authorId: leadNotes.authorId,
      leadOrganizationId: leads.organizationId,
    })
    .from(leadNotes)
    .innerJoin(leads, eq(leadNotes.leadId, leads.id))
    .where(and(eq(leadNotes.id, noteId), eq(leadNotes.leadId, leadId)))
    .limit(1);

  if (!existing) throw new NotFoundError("Lead note not found");
  if (existing.leadOrganizationId !== organizationId) {
    throw new NotFoundError("Lead note not found");
  }
  if (existing.authorId !== actorId) {
    throw new AuthorizationError("Only the note author may update a note");
  }

  const [updated] = await db
    .update(leadNotes)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(leadNotes.id, noteId), eq(leadNotes.leadId, leadId)))
    .returning();

  if (!updated) throw new NotFoundError("Lead note not found");

  await logLeadEvent({
    organizationId,
    leadId,
    type: "note_updated",
    actorId,
    metadata: { noteId: updated.id },
  });

  return {
    id: updated.id,
    type: updated.type,
    content: updated.content,
    authorId: updated.authorId,
    authorName: null,
    authorRole: null,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
};

export const deleteLeadNote = async (
  noteId: string,
  leadId: string,
  organizationId: string,
  actorId: string,
): Promise<void> => {
  const [existing] = await db
    .select({
      id: leadNotes.id,
      authorId: leadNotes.authorId,
      leadOrganizationId: leads.organizationId,
    })
    .from(leadNotes)
    .innerJoin(leads, eq(leadNotes.leadId, leads.id))
    .where(and(eq(leadNotes.id, noteId), eq(leadNotes.leadId, leadId)))
    .limit(1);

  if (!existing) throw new NotFoundError("Lead note not found");
  if (existing.leadOrganizationId !== organizationId) {
    throw new NotFoundError("Lead note not found");
  }
  if (existing.authorId !== actorId) {
    throw new AuthorizationError("Only the note author may delete a note");
  }

  await db
    .delete(leadNotes)
    .where(and(eq(leadNotes.id, noteId), eq(leadNotes.leadId, leadId)));

  await logLeadEvent({
    organizationId,
    leadId,
    type: "note_deleted",
    actorId,
    metadata: { noteId },
  });
};
