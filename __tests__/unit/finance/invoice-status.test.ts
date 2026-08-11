import { describe, expect, it } from "@jest/globals";
import { formatInvoiceNumber } from "../../../src/modules/finance/invoice-number";
import { deriveStoredStatus } from "../../../src/modules/finance/totals";

describe("formatInvoiceNumber", () => {
  it("zero-pads to four digits", () => {
    expect(formatInvoiceNumber(2026, 1)).toBe("INV-2026-0001");
    expect(formatInvoiceNumber(2026, 42)).toBe("INV-2026-0042");
  });

  it("does not truncate once past four digits", () => {
    expect(formatInvoiceNumber(2026, 1234)).toBe("INV-2026-1234");
    expect(formatInvoiceNumber(2026, 12345)).toBe("INV-2026-12345");
  });

  it("carries the year it is given", () => {
    // The caller resolves the year in the firm's timezone, so an invoice
    // issued at 23:00 on Dec 31 in Los Angeles is not numbered for next year.
    expect(formatInvoiceNumber(2027, 1)).toBe("INV-2027-0001");
  });
});

describe("deriveStoredStatus", () => {
  it("marks paid once the balance is covered", () => {
    expect(deriveStoredStatus("sent", 100, 100)).toBe("paid");
    expect(deriveStoredStatus("partial", 100, 100)).toBe("paid");
  });

  it("marks an overpayment paid rather than leaving it partial forever", () => {
    // `>=`, not `===`. An invoice stuck at partial because the client rounded
    // up would never leave the collections list.
    expect(deriveStoredStatus("sent", 100, 120)).toBe("paid");
  });

  it("marks partial while something is still owed", () => {
    expect(deriveStoredStatus("sent", 100, 40)).toBe("partial");
    expect(deriveStoredStatus("sent", 100, 99.99)).toBe("partial");
  });

  it("returns to sent when payments are reversed to zero", () => {
    expect(deriveStoredStatus("partial", 100, 0)).toBe("sent");
    expect(deriveStoredStatus("paid", 100, 0)).toBe("sent");
  });

  it("never transitions out of void", () => {
    // A stray payment against a voided invoice must not resurrect it.
    expect(deriveStoredStatus("void", 100, 100)).toBe("void");
    expect(deriveStoredStatus("void", 100, 0)).toBe("void");
  });

  it("leaves a draft as a draft", () => {
    // Drafts are excluded from every money tile; a payment cannot promote one.
    expect(deriveStoredStatus("draft", 100, 100)).toBe("draft");
  });

  it("does not mark a zero-total invoice paid", () => {
    // Otherwise an empty invoice would report itself settled.
    expect(deriveStoredStatus("sent", 0, 0)).toBe("sent");
  });
});
