import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { leadNotes, leads } from "../../db/schema/leads";
import type { LeadNoteType, LeadNoteContext, LeadNoteVisibility } from "../../db/schema/leads";
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
  context: LeadNoteContext;
  visibility: LeadNoteVisibility;
  isPinned: boolean;
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
  opts?: { context?: string; authorId?: string; userRole?: string; pinnedOnly?: boolean; page?: number; limit?: number },
): Promise<{ data: LeadNoteEntry[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> => {
  const [lead] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)),
    )
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");

  const page = opts?.page ?? 1;
  const limit = opts?.limit ?? 50;

  const conditions = [eq(leadNotes.leadId, leadId)];

  // Pinned-only mode: return pinned notes with role-based visibility filtering
  if (opts?.pinnedOnly) {
    conditions.push(eq(leadNotes.isPinned, true));

    // Role-based visibility filtering — always applied
    const role = opts?.userRole ?? "paralegal";
    if (role === "admin") {
      // Admins can see everything
    } else if (role === "attorney") {
      conditions.push(sql`${leadNotes.visibility} IN ('all_staff', 'attorneys_only')`);
    } else {
      conditions.push(eq(leadNotes.visibility, "all_staff"));
    }
  } else {
    // Exclude pinned notes from regular query (they're fetched separately)
    conditions.push(eq(leadNotes.isPinned, false));

    if (opts?.context) {
      conditions.push(eq(leadNotes.context, opts.context as any));
    }
    if (opts?.authorId) {
      conditions.push(eq(leadNotes.authorId, opts.authorId));
    }

    // Role-based visibility filtering — always applied
    const role = opts?.userRole ?? "paralegal";
    if (role === "admin") {
      // Admins can see everything
    } else if (role === "attorney") {
      // Attorneys can see all_staff and attorneys_only
      conditions.push(sql`${leadNotes.visibility} IN ('all_staff', 'attorneys_only')`);
    } else {
      // Paralegals, staff, etc. can only see all_staff
      conditions.push(eq(leadNotes.visibility, "all_staff"));
    }
  }

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leadNotes)
    .where(and(...conditions));

  const total = countRows[0]?.count ?? 0;
  const offset = (page - 1) * limit;

  const rows = await db
    .select({
      id: leadNotes.id,
      type: leadNotes.type,
      context: leadNotes.context,
      visibility: leadNotes.visibility,
      isPinned: leadNotes.isPinned,
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
    .where(and(...conditions))
    .orderBy(desc(leadNotes.isPinned), asc(leadNotes.createdAt))
    .limit(limit)
    .offset(offset);

  const data = rows.map((r) => ({
    id: r.id,
    type: r.type,
    context: r.context,
    visibility: r.visibility,
    isPinned: r.isPinned,
    content: r.content,
    authorId: r.authorId,
    authorName: r.firstName ? `${r.firstName} ${r.lastName}`.trim() : null,
    authorRole: r.authorRole,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));

  return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
};

export const addLeadNote = async (
  leadId: string,
  organizationId: string,
  data: { type?: LeadNoteType; content: string; context?: LeadNoteContext; visibility?: LeadNoteVisibility; isPinned?: boolean },
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
  const context = data.context ?? "manual";
  const visibility = data.visibility ?? "all_staff";
  const isPinned = data.isPinned ?? false;
  const contentPreview = data.content.slice(0, 200);

  const note = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(leadNotes)
      .values({ leadId, authorId, type, context, visibility, isPinned, content: data.content })
      .returning();

    await logLeadEvent({
      organizationId,
      leadId,
      type: "note_added",
      actorId: authorId,
      metadata: { noteId: created.id, noteType: type, context, contentPreview },
      tx,
    });

    return created;
  });

  return {
    id: note.id,
    type: note.type,
    context: note.context,
    visibility: note.visibility,
    isPinned: note.isPinned,
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
      content: leadNotes.content,
      type: leadNotes.type,
      context: leadNotes.context,
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

  const previousContent = existing.content;
  const previousType = existing.type;

  const [updated] = await db
    .update(leadNotes)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(leadNotes.id, noteId), eq(leadNotes.leadId, leadId)))
    .returning();

  if (!updated) throw new NotFoundError("Lead note not found");

  const changes: Record<string, unknown> = {};
  if (data.content !== undefined && data.content !== previousContent) {
    changes.content = { from: previousContent.slice(0, 200), to: data.content.slice(0, 200) };
  }
  if (data.type !== undefined && data.type !== previousType) {
    changes.type = { from: previousType, to: data.type };
  }

  await logLeadEvent({
    organizationId,
    leadId,
    type: "note_updated",
    actorId,
    metadata: {
      noteId: updated.id,
      noteType: updated.type,
      context: existing.context,
      previousContent: previousContent.slice(0, 200),
      newContent: updated.content.slice(0, 200),
      changes,
    },
  });

  return {
    id: updated.id,
    type: updated.type,
    context: updated.context,
    visibility: updated.visibility,
    isPinned: updated.isPinned,
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
      content: leadNotes.content,
      type: leadNotes.type,
      context: leadNotes.context,
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

  const deletedContent = existing.content;
  const deletedType = existing.type;
  const deletedContext = existing.context;

  await db
    .delete(leadNotes)
    .where(and(eq(leadNotes.id, noteId), eq(leadNotes.leadId, leadId)));

  await logLeadEvent({
    organizationId,
    leadId,
    type: "note_deleted",
    actorId,
    metadata: {
      noteId,
      noteType: deletedType,
      context: deletedContext,
      deletedContent: deletedContent.slice(0, 200),
    },
  });
};

export const bulkDeleteNotes = async (
  leadId: string,
  noteIds: string[],
  organizationId: string,
  actorId: string,
): Promise<{ deleted: number }> => {
  const [lead] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");

  const existing = await db
    .select({ id: leadNotes.id, authorId: leadNotes.authorId })
    .from(leadNotes)
    .where(and(inArray(leadNotes.id, noteIds), eq(leadNotes.leadId, leadId)));

  const toDelete = existing.map((n) => n.id);
  if (toDelete.length === 0) return { deleted: 0 };

  await db
    .delete(leadNotes)
    .where(and(inArray(leadNotes.id, toDelete), eq(leadNotes.leadId, leadId)));

  await logLeadEvent({
    organizationId,
    leadId,
    type: "note_deleted",
    actorId,
    metadata: { noteIds: toDelete, bulk: true, count: toDelete.length },
  });

  return { deleted: toDelete.length };
};

export const bulkPinNotes = async (
  leadId: string,
  noteIds: string[],
  pinned: boolean,
  organizationId: string,
  actorId: string,
): Promise<{ updated: number }> => {
  const [lead] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");

  const toUpdate = await db
    .select({ id: leadNotes.id })
    .from(leadNotes)
    .where(and(inArray(leadNotes.id, noteIds), eq(leadNotes.leadId, leadId)));

  if (toUpdate.length === 0) return { updated: 0 };

  await db
    .update(leadNotes)
    .set({ isPinned: pinned, updatedAt: new Date() })
    .where(and(inArray(leadNotes.id, toUpdate.map((n) => n.id)), eq(leadNotes.leadId, leadId)));

  return { updated: toUpdate.length };
};

export const toggleNotePin = async (
  noteId: string,
  leadId: string,
  organizationId: string,
  actorId: string,
): Promise<LeadNoteEntry> => {
  const [existing] = await db
    .select({ id: leadNotes.id, isPinned: leadNotes.isPinned })
    .from(leadNotes)
    .innerJoin(leads, eq(leadNotes.leadId, leads.id))
    .where(and(eq(leadNotes.id, noteId), eq(leadNotes.leadId, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!existing) throw new NotFoundError("Lead note not found");

  const newPinned = !existing.isPinned;

  const [updated] = await db
    .update(leadNotes)
    .set({ isPinned: newPinned, updatedAt: new Date() })
    .where(eq(leadNotes.id, noteId))
    .returning();

  await logLeadEvent({
    organizationId,
    leadId,
    type: newPinned ? "note_pinned" : "note_unpinned",
    actorId,
    metadata: { noteId, isPinned: newPinned },
  });

  return {
    id: updated.id,
    type: updated.type,
    context: updated.context,
    visibility: updated.visibility,
    isPinned: updated.isPinned,
    content: updated.content,
    authorId: updated.authorId,
    authorName: null,
    authorRole: null,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
};
