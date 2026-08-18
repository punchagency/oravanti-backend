import { describe, expect, it } from "@jest/globals";
import {
  CONFIDO_FIRM_STATUSES,
  canAcceptPayments,
  isKnownFirmStatus,
  isTerminalState,
  normalizeFirmStatus,
  stateForStatus,
} from "../../../src/modules/finance/confido/firm-status";

describe("stateForStatus", () => {
  it("maps every status Confido documents", () => {
    expect(stateForStatus("CREATED")).toBe("application_needed");
    expect(stateForStatus("APP_IN_DRAFT")).toBe("application_in_progress");
    expect(stateForStatus("APP_SUBMITTED")).toBe("under_review");
    expect(stateForStatus("APP_IN_REVIEW")).toBe("under_review");
    expect(stateForStatus("ACTIVE")).toBe("active");
    expect(stateForStatus("DECLINED")).toBe("declined");
    expect(stateForStatus("INACTIVE")).toBe("inactive");
    expect(stateForStatus("SUSPENDED")).toBe("suspended");
  });

  it("covers the whole enum, so a new value cannot be added without a mapping", () => {
    for (const status of CONFIDO_FIRM_STATUSES) {
      expect(stateForStatus(status)).not.toBe("unknown");
    }
  });

  it("reports an unrecognised status as unknown rather than guessing", () => {
    // Confido added DECLINED in Jan 2026 without notice, so the set grows. The
    // guess that costs most is guessing "active".
    expect(stateForStatus("SOME_NEW_STATUS")).toBe("unknown");
    expect(stateForStatus("")).toBe("unknown");
  });

  it("tolerates casing and whitespace drift", () => {
    expect(stateForStatus(" active ")).toBe("active");
    expect(stateForStatus("Active")).toBe("active");
  });
});

describe("normalizeFirmStatus", () => {
  it("handles null and undefined without throwing", () => {
    expect(normalizeFirmStatus(null)).toBe("");
    expect(normalizeFirmStatus(undefined)).toBe("");
  });
});

describe("isKnownFirmStatus", () => {
  it("narrows only for documented values", () => {
    expect(isKnownFirmStatus("ACTIVE")).toBe(true);
    expect(isKnownFirmStatus("NOPE")).toBe(false);
    // Narrowing happens on the normalized form; the caller normalizes first.
    expect(isKnownFirmStatus("active")).toBe(false);
  });
});

describe("canAcceptPayments", () => {
  it("requires ACTIVE and the operational flag together", () => {
    expect(canAcceptPayments("ACTIVE", true)).toBe(true);
  });

  it("refuses when the two disagree", () => {
    // The spike saw createFirm return a payload where status and
    // isAcceptingPayments contradicted each other, which is why both are stored.
    expect(canAcceptPayments("ACTIVE", false)).toBe(false);
    expect(canAcceptPayments("CREATED", true)).toBe(false);
  });

  it("refuses for every non-active status", () => {
    for (const status of CONFIDO_FIRM_STATUSES) {
      if (status === "ACTIVE") continue;
      expect(canAcceptPayments(status, true)).toBe(false);
    }
  });

  it("refuses for an unknown status even when the flag is set", () => {
    expect(canAcceptPayments("SOMETHING_NEW", true)).toBe(false);
  });
});

describe("isTerminalState", () => {
  it("is true only for declined", () => {
    // Terminal means "no retry button", so a false positive strands a firm that
    // could have proceeded and a false negative offers a button that cannot work.
    expect(isTerminalState("declined")).toBe(true);
    expect(isTerminalState("suspended")).toBe(false);
    expect(isTerminalState("inactive")).toBe(false);
    expect(isTerminalState("unknown")).toBe(false);
  });
});
