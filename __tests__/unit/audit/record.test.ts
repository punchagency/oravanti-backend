import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

/**
 * The audit writer.
 *
 * What is being asserted here is mostly *what ends up in the row*, because
 * every defect the eleven tables this replaces actually suffered from was of
 * that shape: an actor column filled from the wrong source, a category that
 * differed between two call sites for the same action, a trail that survived
 * its subject or did not. Asserting that a function was called would catch
 * none of them.
 *
 * The database is mocked; the request context is real. Binding identity from
 * `AsyncLocalStorage` is the mechanism under test, so stubbing it out would
 * leave the most important behaviour unexercised.
 */

type Row = Record<string, any>;

const inserts: { table: unknown; row: Row }[] = [];
let insertFails: Error | null = null;
let dedupeRows: unknown[] = [];

const mockDb = {
  insert: jest.fn((table: unknown) => ({
    values: async (row: Row) => {
      if (insertFails) throw insertFails;
      inserts.push({ table, row });
    },
  })),
  select: jest.fn(() => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => dedupeRows,
    };
    return chain;
  }),
};

jest.mock("../../../src/db/client", () => ({ db: mockDb }));

import { auditEvents } from "../../../src/db/schema/audit-events";
import {
  runWithRequestContext,
  type RequestContext,
} from "../../../src/middleware/request-context";
import { captureLogs, type LogCapture } from "../logging/capture";

/**
 * Loaded lazily, and it has to be.
 *
 * The swc transform emits every `require` above the `jest.mock` call, so a
 * static import of the service binds the real `db` before the mock is
 * registered — and the suite quietly runs against whatever database
 * `DATABASE_URL` points at instead of failing. Importing inside `beforeAll`
 * defers the require until the module registry already holds the mock. The
 * neighbouring `practice-areas` suite does the same thing for the same reason.
 */
type AuditService = typeof import("../../../src/modules/shared/audit.service");
let recordAuditEvent: AuditService["recordAuditEvent"];
let recordAccessEvent: AuditService["recordAccessEvent"];

beforeAll(async () => {
  ({ recordAuditEvent, recordAccessEvent } = await import(
    "../../../src/modules/shared/audit.service"
  ));
});

/** A fully-populated staff request — the ordinary case every business event runs under. */
const staffContext: Partial<RequestContext> & { source: RequestContext["source"] } = {
  source: "http",
  requestId: "req-abc123",
  ipAddress: "203.0.113.7",
  userAgent: "Mozilla/5.0 (test)",
  userId: "user-1",
  organizationId: "firm-1",
  staffId: "staff-1",
  actorType: "staff",
  actorName: "Ada Okafor",
};

const asStaff = <T>(fn: () => Promise<T>) => runWithRequestContext(staffContext, fn);

const onlyRow = (): Row => {
  expect(inserts).toHaveLength(1);
  return inserts[0].row;
};

let logs: LogCapture;

beforeEach(() => {
  inserts.length = 0;
  insertFails = null;
  dedupeRows = [];
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
});

describe("recordAuditEvent — identity", () => {
  it("fills actor, tenant and correlation from the request context", async () => {
    // None of this is passed by the call site. That is the point: the tables
    // this replaces each took the actor as an argument and between them used
    // seven conventions for it, which is how rows ended up attributed to a
    // staff id in a column documented as a user id.
    await asStaff(() =>
      recordAuditEvent({ action: "lead.stage_changed", entityId: "lead-9" }),
    );

    expect(onlyRow()).toMatchObject({
      organizationId: "firm-1",
      actorType: "staff",
      actorId: "user-1",
      actorStaffId: "staff-1",
      actorName: "Ada Okafor",
      requestId: "req-abc123",
      ipAddress: "203.0.113.7",
      userAgent: "Mozilla/5.0 (test)",
      source: "http",
    });
  });

  it("lets an explicit actor override the context, field by field", async () => {
    // Sign-in has no session yet, so the context holds no user. Fields the
    // caller omits must still fall through rather than being nulled out.
    await asStaff(() =>
      recordAuditEvent({
        action: "auth.password_changed",
        actor: { email: "ada@example.com" },
      }),
    );

    expect(onlyRow()).toMatchObject({
      actorId: "user-1", // from the context
      actorName: "Ada Okafor", // from the context
      actorEmail: "ada@example.com", // from the override
    });
  });

  it("records an unauthenticated attempt with no actor and no tenant", async () => {
    // A failed sign-in is the event that matters most and the one with the
    // least to go on: an email and an IP. It must still be storable.
    await runWithRequestContext(
      { source: "http", requestId: "req-nobody", ipAddress: "198.51.100.4" },
      () =>
        recordAuditEvent({
          action: "auth.login_failed",
          entityId: null,
          actor: { email: "attacker@example.com" },
          organizationId: null,
        }),
    );

    expect(onlyRow()).toMatchObject({
      organizationId: null,
      actorId: null,
      actorType: "anonymous",
      actorEmail: "attacker@example.com",
      ipAddress: "198.51.100.4",
    });
  });

  it("never leaves actor name null", async () => {
    // Null here is indistinguishable from a deleted account, which is the
    // ambiguity the snapshot exists to prevent. Falls through name, then
    // email, then a sentinel for the actor type.
    await runWithRequestContext({ source: "queue", actorType: "system" }, () =>
      recordAuditEvent({ action: "system.retention_purge" }),
    );

    expect(onlyRow().actorName).toBe("System");
  });

  it("falls back to the email when no name is known anywhere", async () => {
    await runWithRequestContext({ source: "http" }, () =>
      recordAuditEvent({
        action: "auth.login_failed",
        actor: { email: "nobody@example.com" },
      }),
    );

    expect(onlyRow().actorName).toBe("nobody@example.com");
  });

  it("carries the source through for work that is not an HTTP request", async () => {
    // Without this, rows written by workers land with a null actor and a null
    // source — which is how the current tables ended up unable to distinguish
    // automated changes from ones a person made.
    await runWithRequestContext({ source: "queue", actorType: "system" }, () =>
      recordAuditEvent({ action: "system.integration_sync" }),
    );

    expect(onlyRow()).toMatchObject({ source: "queue", actorType: "system" });
  });
});

describe("recordAuditEvent — the registry decides the classification", () => {
  it("takes category, CRUD verb and entity type from the action, not the caller", async () => {
    await asStaff(() =>
      recordAuditEvent({ action: "case.step_approved", entityId: "step-4" }),
    );

    expect(onlyRow()).toMatchObject({
      action: "case.step_approved",
      category: "business",
      actionType: "update",
      entityType: "workflow_step",
      entityId: "step-4",
    });
  });

  it("classifies an authentication event as security wherever it is written from", async () => {
    await asStaff(() => recordAuditEvent({ action: "auth.login_failed" }));

    expect(onlyRow().category).toBe("security");
  });

  it("allows the entity type to be overridden but not the category", async () => {
    await asStaff(() =>
      recordAuditEvent({
        action: "document.access_granted",
        entityType: "document_version",
        entityId: "ver-2",
      }),
    );

    expect(onlyRow()).toMatchObject({
      entityType: "document_version",
      category: "admin",
    });
  });

  it("defaults the summary to the registry label and prefers an explicit one", async () => {
    await asStaff(() => recordAuditEvent({ action: "lead.archived" }));
    expect(onlyRow().summary).toBe("Lead archived");

    inserts.length = 0;
    await asStaff(() =>
      recordAuditEvent({
        action: "lead.archived",
        summary: "Ada archived Ben Idris after the conflict check failed",
      }),
    );
    expect(onlyRow().summary).toBe(
      "Ada archived Ben Idris after the conflict check failed",
    );
  });

  it("links a nested entity to the matter it belongs to", async () => {
    await asStaff(() =>
      recordAuditEvent({
        action: "case.note_created",
        entityId: "note-3",
        parentEntityType: "case",
        parentEntityId: "case-7",
      }),
    );

    expect(onlyRow()).toMatchObject({
      entityType: "case_note",
      entityId: "note-3",
      parentEntityType: "case",
      parentEntityId: "case-7",
    });
  });
});

describe("recordAuditEvent — redaction", () => {
  it("strips credentials and key material from before and after", async () => {
    // These rows are kept for seven years and nothing may delete from the
    // table, so a leak here is markedly worse than the same leak in a log line
    // that rotates away in thirty days.
    await asStaff(() =>
      recordAuditEvent({
        action: "admin.staff_updated",
        entityId: "staff-2",
        before: { email: "ben@example.com", passwordHash: "$2b$10$oldhash" },
        after: { email: "ben@example.com", passwordHash: "$2b$10$newhash" },
      }),
    );

    const row = onlyRow();
    expect(row.before.passwordHash).toBe("[REDACTED]");
    expect(row.after.passwordHash).toBe("[REDACTED]");
    // Email is deliberately NOT redacted — it is the identifier that makes an
    // account change reviewable at all.
    expect(row.after.email).toBe("ben@example.com");
  });

  it("reaches key material nested inside metadata", async () => {
    await asStaff(() =>
      recordAuditEvent({
        action: "system.dek_rotated",
        metadata: { tenant: { rawUserDEK: Buffer.from("secret"), attempts: 2 } },
      }),
    );

    const row = onlyRow();
    expect(row.metadata.tenant.rawUserDEK).toBe("[REDACTED]");
    expect(row.metadata.tenant.attempts).toBe(2);
  });

  it("writes an empty object rather than null when there is no metadata", async () => {
    // The column is `not null default '{}'`; a null would make every consumer
    // guard before reading it.
    await asStaff(() => recordAuditEvent({ action: "lead.received" }));

    expect(onlyRow().metadata).toEqual({});
  });
});

describe("recordAuditEvent — failure policy", () => {
  it("throws by default, so the caller's transaction rolls back with it", async () => {
    // For a legal record this is the only defensible semantic: either the
    // change and the row describing it both land, or neither does.
    insertFails = new Error("connection terminated");

    await expect(
      asStaff(() => recordAuditEvent({ action: "case.status_changed" })),
    ).rejects.toThrow("connection terminated");
  });

  it("swallows and reports the loss when the caller opted out of throwing", async () => {
    // Only for events describing something already committed elsewhere. A
    // rejected sign-in is not a transaction to undo, and an unreachable audit
    // table must not become a 500 on the login endpoint.
    insertFails = new Error("connection terminated");

    await expect(
      asStaff(() =>
        recordAuditEvent({
          action: "auth.login_failed",
          actor: { email: "attacker@example.com" },
          onWriteFailure: "log",
        }),
      ),
    ).resolves.toBeUndefined();

    expect(logs.only()).toMatchObject({
      event: "audit.write_failed",
      auditAction: "auth.login_failed",
      category: "security",
      actorEmail: "attacker@example.com",
    });
  });

  it("says enough in that log line to reconstruct the lost row by hand", async () => {
    insertFails = new Error("disk full");

    await asStaff(() =>
      recordAuditEvent({
        action: "admin.staff_deleted",
        entityId: "staff-9",
        onWriteFailure: "log",
      }),
    );

    expect(logs.only()).toMatchObject({
      entityType: "staff",
      entityId: "staff-9",
      organizationId: "firm-1",
      actorId: "user-1",
      level: "error",
    });
  });
});

describe("recordAccessEvent", () => {
  it("records a view in the same table, flagged as an access", async () => {
    await asStaff(() =>
      recordAccessEvent({ action: "case.viewed", entityId: "case-7" }),
    );

    expect(inserts[0].table).toBe(auditEvents);
    expect(inserts[0].row).toMatchObject({
      action: "case.viewed",
      entityType: "case",
      entityId: "case-7",
      actorId: "user-1",
    });
  });

  it("writes changes to audit_events, for contrast", async () => {
    await asStaff(() => recordAuditEvent({ action: "case.updated", entityId: "case-7" }));

    expect(inserts[0].table).toBe(auditEvents);
  });

  it("suppresses a repeat view inside the dedupe window", async () => {
    // Tab switches, re-renders and polling would otherwise bury the access
    // patterns this table exists to show — a polling page writes a row a
    // second and tells you nothing you did not already know.
    dedupeRows = [{ id: "existing" }];

    await asStaff(() =>
      recordAccessEvent({ action: "case.viewed", entityId: "case-7" }),
    );

    expect(inserts).toHaveLength(0);
  });

  it("records every occurrence when the window is disabled", async () => {
    // A download or an export is meaningful each time it happens.
    dedupeRows = [{ id: "existing" }];

    await asStaff(() =>
      recordAccessEvent({
        action: "document.downloaded",
        entityId: "doc-1",
        dedupeWindowMs: 0,
      }),
    );

    expect(inserts).toHaveLength(1);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("does not deduplicate when there is no actor to deduplicate against", async () => {
    // Two anonymous views are not known to be the same person; collapsing them
    // would discard real access history.
    dedupeRows = [{ id: "existing" }];

    await runWithRequestContext({ source: "http" }, () =>
      recordAccessEvent({ action: "document.viewed", entityId: "doc-1" }),
    );

    expect(inserts).toHaveLength(1);
  });

  it("never throws, and never fails the read it describes", async () => {
    insertFails = new Error("connection terminated");

    await expect(
      asStaff(() => recordAccessEvent({ action: "case.viewed", entityId: "case-7" })),
    ).resolves.toBeUndefined();

    expect(logs.only()).toMatchObject({
      event: "audit.access_write_failed",
      accessAction: "case.viewed",
    });
  });
});
