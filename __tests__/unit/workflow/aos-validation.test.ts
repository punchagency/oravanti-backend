import { describe, expect, it } from "@jest/globals";
import {
  evaluateAosPitfalls,
  type AosPitfallInput,
} from "../../../src/modules/workflow/aos-validation.service";

/*
  The § 1.5 pitfalls.

  Two properties are being defended here, and they pull in opposite directions:

    - A rule must fire when it should. Each of these is a real way a matter is
      lost, and the whole point of encoding them is that a person will not spot
      every one on every case.
    - A rule must stay silent when it lacks the facts. A screen of permanent
      warnings caused by unfilled fields is a screen nobody reads, at which point
      the rules that DO fire are invisible too.

  So every rule below is tested in both directions, and the "silent" half is
  the one that matters more.
*/

const base: AosPitfallInput = {
  today: "2026-08-25",
  filingDate: null,
  caseIsOpen: true,
  filingTrack: "concurrent",
  travelWhilePending: [],
  beneficiaryStatusExpirationDate: null,
  employmentStartDate: null,
  hasWorkAuthorization: false,
  cardValidTo: null,
  sponsorIncomeCents: null,
  sponsorHouseholdSize: null,
  i864Verdict: null,
  i693SignedDate: null,
  supersededForms: [],
};

const codes = (o: Partial<AosPitfallInput> = {}) =>
  evaluateAosPitfalls({ ...base, ...o }).map((p) => p.code);

const only = (o: Partial<AosPitfallInput>) => {
  const found = evaluateAosPitfalls({ ...base, ...o });
  expect(found).toHaveLength(1);
  return found[0];
};

describe("an empty case raises nothing at all", () => {
  it("is silent when it knows nothing", () => {
    // The single most important assertion in this file. A case someone has just
    // opened must not be covered in warnings about fields they have not reached.
    expect(evaluateAosPitfalls(base)).toEqual([]);
  });
});

describe("#1 travel without advance parole", () => {
  const travelled = {
    filingDate: "2026-01-15",
    travelWhilePending: [
      { departureDate: "2026-03-02", returnDate: "2026-03-20", hadAdvanceParole: false },
    ],
  };

  it("warns about a trip taken after filing with no advance parole", () => {
    const pitfall = only(travelled);

    expect(pitfall.code).toBe("travel_without_advance_parole");
    expect(pitfall.message).toContain("2026-03-02");
  });

  it("warns rather than blocks, because H and L status travel is lawful", () => {
    // The document reads as a hard block. Blocking would stop lawful travel on
    // the strength of a status field the system was never told.
    expect(only(travelled).severity).toBe("warning");
  });

  it("is silent when the trip had advance parole", () => {
    expect(
      codes({
        ...travelled,
        travelWhilePending: [
          { departureDate: "2026-03-02", returnDate: "2026-03-20", hadAdvanceParole: true },
        ],
      }),
    ).toEqual([]);
  });

  it("is silent about travel BEFORE the I-485 was filed", () => {
    // Nothing was pending to abandon.
    expect(
      codes({
        filingDate: "2026-06-01",
        travelWhilePending: [
          { departureDate: "2026-03-02", returnDate: "2026-03-20", hadAdvanceParole: false },
        ],
      }),
    ).toEqual([]);
  });

  it("is silent when nothing has been filed yet", () => {
    expect(codes({ ...travelled, filingDate: null })).toEqual([]);
  });
});

describe("#2 employment before work authorisation", () => {
  it("warns when work started with no authorisation on file", () => {
    expect(only({ employmentStartDate: "2026-04-01" }).code).toBe(
      "employment_before_work_authorization",
    );
  });

  it("is silent for an independently work-authorised beneficiary", () => {
    // H-1B, L-2, or an EAD already in hand from another basis.
    expect(codes({ employmentStartDate: "2026-04-01", hasWorkAuthorization: true })).toEqual([]);
  });

  it("is silent when an EAD covers the start date", () => {
    expect(codes({ employmentStartDate: "2026-04-01", cardValidTo: "2027-04-01" })).toEqual([]);
  });

  it("still warns when work started after the EAD expired", () => {
    expect(codes({ employmentStartDate: "2026-04-01", cardValidTo: "2026-01-01" })).toEqual([
      "employment_before_work_authorization",
    ]);
  });
});

describe("#3 I-864 income below the threshold", () => {
  it("warns and suggests the actual remedies", () => {
    const pitfall = only({
      i864Verdict: { verdict: "below", thresholdCents: 3_415_000, because: "Needs $34,150." },
    });

    expect(pitfall.code).toBe("i864_income_below_threshold");
    expect(pitfall.message).toContain("joint sponsor");
    expect(pitfall.message).toContain("I-864A");
  });

  it("is silent when the sponsor meets the threshold", () => {
    expect(
      codes({ i864Verdict: { verdict: "meets", thresholdCents: 3_415_000, because: "ok" } }),
    ).toEqual([]);
  });

  it("is silent when the threshold itself is unknown", () => {
    /*
      "unknown" means WE lack the reference table — Alaska and Hawaii are
      deliberately unseeded because two sources disagreed. That is our gap, not a
      defect in the client's case, and surfacing it as a case warning would put
      our problem in front of the attorney as if it were theirs.
    */
    expect(codes({ i864Verdict: { verdict: "unknown", because: "No table." } })).toEqual([]);
  });
});

describe("#4 I-693 bound to a closed application", () => {
  it("warns once the application it was filed with is no longer pending", () => {
    const pitfall = only({ i693SignedDate: "2026-02-10", caseIsOpen: false });

    expect(pitfall.code).toBe("i693_bound_to_closed_application");
    expect(pitfall.message).toContain("new medical exam");
  });

  it("never warns merely because the signature is old", () => {
    /*
      The correction that matters most in this rule. Since 11 June 2025 the I-693
      has no fixed validity window, so a two-year-old signature on a pending
      application is fine. A date-based rule here would send firms for
      unnecessary medical exams at real cost to clients.
    */
    expect(codes({ i693SignedDate: "2019-01-01", caseIsOpen: true })).toEqual([]);
  });
});

describe("#5 status expired before filing", () => {
  const lapsed = {
    filingTrack: "sequential" as const,
    beneficiaryStatusExpirationDate: "2026-05-01",
  };

  it("warns on a sequential matter whose status ran out before filing", () => {
    expect(only(lapsed).code).toBe("status_expired_before_filing");
  });

  it("is silent on a concurrent matter", () => {
    // A concurrent filing goes in immediately — there is no waiting period to
    // fall out of status during.
    expect(codes({ ...lapsed, filingTrack: "concurrent" })).toEqual([]);
  });

  it("is silent once the I-485 has actually been filed", () => {
    expect(codes({ ...lapsed, filingDate: "2026-04-01" })).toEqual([]);
  });

  it("is silent while the status is still valid", () => {
    expect(codes({ ...lapsed, beneficiaryStatusExpirationDate: "2027-05-01" })).toEqual([]);
  });
});

describe("#6 superseded form edition — the only hard block", () => {
  it("blocks rather than warns", () => {
    /*
      The one rule with no judgement in it: USCIS rejects a package on a
      superseded edition, sometimes with no grace period. Every other rule here
      depends on facts the system cannot see, which is why this is the only one
      allowed to stop anybody.
    */
    const pitfall = only({ supersededForms: ["I-485", "I-765"] });

    expect(pitfall.code).toBe("form_edition_superseded");
    expect(pitfall.severity).toBe("block");
    expect(pitfall.message).toContain("I-485");
  });

  it("is the only rule that ever blocks", () => {
    const everything = evaluateAosPitfalls({
      ...base,
      filingDate: "2026-01-15",
      filingTrack: "sequential",
      travelWhilePending: [
        { departureDate: "2026-03-02", returnDate: null, hadAdvanceParole: false },
      ],
      employmentStartDate: "2026-04-01",
      i864Verdict: { verdict: "below", thresholdCents: 3_415_000, because: "Needs $34,150." },
      i693SignedDate: "2026-02-10",
      caseIsOpen: false,
      supersededForms: ["I-485"],
    });

    const blocking = everything.filter((p) => p.severity === "block").map((p) => p.code);
    expect(blocking).toEqual(["form_edition_superseded"]);
    // And everything else still fired, so the block is not masking them.
    expect(everything.length).toBeGreaterThan(1);
  });
});

describe("every pitfall names the facts it fired on", () => {
  it("gives a message a person can act on without opening the code", () => {
    const everything = evaluateAosPitfalls({
      ...base,
      filingDate: "2026-01-15",
      filingTrack: "sequential",
      travelWhilePending: [
        { departureDate: "2026-03-02", returnDate: null, hadAdvanceParole: false },
      ],
      employmentStartDate: "2026-04-01",
      i864Verdict: { verdict: "below", thresholdCents: 3_415_000, because: "Needs $34,150." },
      supersededForms: ["I-485"],
    });

    for (const pitfall of everything) {
      expect(pitfall.message.length).toBeGreaterThan(40);
      // A message with no date, amount or form number in it is a generic
      // warning, and a generic warning is one nobody can act on.
      expect(pitfall.message).toMatch(/\d/);
    }
  });
});
