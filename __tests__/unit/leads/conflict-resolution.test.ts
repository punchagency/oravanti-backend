import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockDb = {
  select: jest.fn(),
  update: jest.fn(),
  insert: jest.fn(),
  transaction: jest.fn(),
};

const mockSendEmail = jest.fn((..._args: unknown[]) => Promise.resolve());

jest.mock("../../../src/db/client", () => ({ db: mockDb }));
jest.mock("../../../src/utils/email/email.service", () => ({
  emailService: { sendEmail: mockSendEmail },
}));

// A drizzle-query stand-in: every builder method returns the same chain, and the
// chain itself is awaitable (thenable) resolving to the configured rows. This
// supports `.where().limit()`, `.set().where().returning()`, etc.
const makeChain = (rows: unknown[]) => {
  const chain: any = {};
  for (const m of [
    "from",
    "leftJoin",
    "innerJoin",
    "where",
    "limit",
    "values",
    "orderBy",
    "groupBy",
    "offset",
    "returning",
  ]) {
    chain[m] = jest.fn(() => chain);
  }
  chain.set = jest.fn(() => chain);
  chain.then = (resolve: any, reject: any) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
};

const importService = async () => {
  const { LeadsService } = await import(
    "../../../src/modules/leads/leads.service"
  );
  return new LeadsService();
};

const ORG = "org-1";
const STAFF = "staff-1";
const LEAD_ID = "lead-1";
const CC_ID = "cc-1";

describe("resolveConflictCheck", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Wires the three pre-transaction selects (lead, staff, conflict check) and
  // the two in-transaction updates (conflict check, lead). Returns the captured
  // update chains so callers can assert on the `.set()` payloads.
  const wire = (lead: any, cc: any) => {
    const selectQueue = [
      makeChain([lead]),
      makeChain([{ id: STAFF }]),
      makeChain([cc]),
    ];
    mockDb.select.mockImplementation(() => selectQueue.shift());

    const ccChain = makeChain([{ id: cc.id, status: cc.status, matches: [] }]);
    const leadChain = makeChain([]);
    const txUpdates = [ccChain, leadChain];
    mockDb.transaction.mockImplementation(async (cb: any) => {
      const tx = { update: jest.fn(() => txUpdates.shift()) };
      return cb(tx);
    });

    return { ccChain, leadChain };
  };

  it("approve(needs_review) -> lead reviewed, CC pass, advances to questionnaire", async () => {
    const { ccChain, leadChain } = wire(
      {
        id: LEAD_ID,
        organizationId: ORG,
        conflictCheckId: CC_ID,
        pipelineStage: "conflict_check",
        status: "new",
        name: "Jane Doe",
        email: "jane@example.com",
      },
      { id: CC_ID, status: "needs_review", matches: [] },
    );

    const svc = await importService();
    await svc.resolveConflictCheck(LEAD_ID, ORG, STAFF, {
      action: "approve",
      reviewNotes: "Cleared after review",
    });

    expect(ccChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pass",
        reviewedById: STAFF,
        reviewNotes: "Cleared after review",
      }),
    );
    expect(leadChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "reviewed",
        pipelineStage: "questionnaire",
      }),
    );
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("approve(conflict_found) -> lead overridden, CC pass, advances to questionnaire", async () => {
    const { ccChain, leadChain } = wire(
      {
        id: LEAD_ID,
        organizationId: ORG,
        conflictCheckId: CC_ID,
        pipelineStage: "conflict_check",
        status: "new",
        name: "Jane Doe",
        email: "jane@example.com",
      },
      { id: CC_ID, status: "conflict_found", matches: [] },
    );

    const svc = await importService();
    await svc.resolveConflictCheck(LEAD_ID, ORG, STAFF, {
      action: "approve",
      reviewNotes: "Override approved by owner",
    });

    expect(ccChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pass" }),
    );
    expect(leadChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "overridden",
        pipelineStage: "questionnaire",
      }),
    );
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("decline -> lead declined, CC conflict_found, no advance, decline email sent", async () => {
    const { ccChain, leadChain } = wire(
      {
        id: LEAD_ID,
        organizationId: ORG,
        conflictCheckId: CC_ID,
        pipelineStage: "conflict_check",
        status: "new",
        name: "Jane Doe",
        email: "jane@example.com",
      },
      { id: CC_ID, status: "conflict_found", matches: [] },
    );

    const svc = await importService();
    await svc.resolveConflictCheck(LEAD_ID, ORG, STAFF, {
      action: "decline",
      reviewNotes: "Direct conflict with existing client",
    });

    expect(ccChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "conflict_found", reviewedById: STAFF }),
    );
    expect(leadChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "declined" }),
    );
    // stage is not touched on decline
    const leadSetArg = (leadChain.set as jest.Mock).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(leadSetArg).not.toHaveProperty("pipelineStage");

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "jane@example.com" }),
    );
  });
});

describe("resolveConflictCheckBodySchema", () => {
  it("rejects a blank note", async () => {
    const { resolveConflictCheckBodySchema } = await import(
      "../../../src/modules/leads/leads.validation"
    );
    const result = resolveConflictCheckBodySchema.safeParse({
      action: "approve",
      reviewNotes: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown action", async () => {
    const { resolveConflictCheckBodySchema } = await import(
      "../../../src/modules/leads/leads.validation"
    );
    const result = resolveConflictCheckBodySchema.safeParse({
      action: "supervisor_override",
      reviewNotes: "valid note",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid approve payload", async () => {
    const { resolveConflictCheckBodySchema } = await import(
      "../../../src/modules/leads/leads.validation"
    );
    const result = resolveConflictCheckBodySchema.safeParse({
      action: "approve",
      reviewNotes: "Cleared after review",
    });
    expect(result.success).toBe(true);
  });
});

describe("runConflictCheck stage handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Every match query returns no rows -> status "pass". The first select is the
  // lead lookup; the rest are the matching queries.
  const wireNoMatches = (lead: any) => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call += 1;
      return makeChain(call === 1 ? [lead] : []);
    });

    const ccUpdateChain = makeChain([{ id: CC_ID, status: "pass", matches: [] }]);
    const leadUpdateChains: any[] = [];
    mockDb.update.mockImplementation(() => {
      // First update() is the conflict_checks upsert; any subsequent update() is
      // the pipeline-stage auto-advance.
      if ((mockDb.update as jest.Mock).mock.calls.length === 1)
        return ccUpdateChain;
      const c = makeChain([]);
      leadUpdateChains.push(c);
      return c;
    });

    return { ccUpdateChain, leadUpdateChains };
  };

  it("clears prior resolution fields when re-running an existing check", async () => {
    const { ccUpdateChain } = wireNoMatches({
      id: LEAD_ID,
      organizationId: ORG,
      conflictCheckId: CC_ID,
      pipelineStage: "conflict_check",
      status: "new",
      name: "Jane Doe",
      email: "jane@example.com",
      intakeAdversePartyName: null,
      intakeAdversePartyEmail: null,
    });

    const svc = await importService();
    await svc.runConflictCheck(LEAD_ID, ORG, STAFF);

    expect(ccUpdateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pass",
        reviewedById: null,
        reviewedAt: null,
        reviewNotes: null,
        supervisorOverrideById: null,
      }),
    );
  });

  it("never regresses a lead that is already past the conflict_check stage", async () => {
    const { leadUpdateChains } = wireNoMatches({
      id: LEAD_ID,
      organizationId: ORG,
      conflictCheckId: CC_ID,
      pipelineStage: "questionnaire", // already further along
      status: "reviewed",
      name: "Jane Doe",
      email: "jane@example.com",
      intakeAdversePartyName: null,
      intakeAdversePartyEmail: null,
    });

    const svc = await importService();
    await svc.runConflictCheck(LEAD_ID, ORG, STAFF);

    // Only the conflict_checks upsert ran; no stage update was issued.
    expect(leadUpdateChains).toHaveLength(0);
  });
});

describe("compareNames", () => {
  it("treats identical normalized names as exact", async () => {
    const { compareNames } = await import(
      "../../../src/modules/leads/leads.service"
    );
    expect(compareNames("Bianchi Family Trust", "bianchi family trust ")).toBe(
      "exact",
    );
  });

  it("matches a bare surname against a company name as partial", async () => {
    const { compareNames } = await import(
      "../../../src/modules/leads/leads.service"
    );
    expect(compareNames("Bianchi", "Bianchi Family Trust")).toBe("partial");
    expect(compareNames("Smith", "John Smith")).toBe("partial");
  });

  it("does not match on entity stopwords alone", async () => {
    const { compareNames } = await import(
      "../../../src/modules/leads/leads.service"
    );
    expect(compareNames("Trust", "Acme Group Trust")).toBeNull();
    expect(compareNames("The Group", "Bianchi Family Trust")).toBeNull();
  });

  it("returns null for unrelated names or missing input", async () => {
    const { compareNames } = await import(
      "../../../src/modules/leads/leads.service"
    );
    expect(compareNames("Bianchi", "Rossi Holdings")).toBeNull();
    expect(compareNames(null, "Bianchi")).toBeNull();
    expect(compareNames("Bianchi", undefined)).toBeNull();
  });
});
