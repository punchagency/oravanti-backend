import type { EffectiveInvoiceStatus, PaymentMethod } from "../../db/schema/invoices";
import type { InvoiceParty } from "./party";

/** The account-visibility levels resolved from `financial_access_controls`. */
export type AccountLevel = "full_access" | "view_only" | "no_access";

export type AccountAccess = {
  operating: AccountLevel;
  trust: AccountLevel;
};

/**
 * Echoed on every finance response so the UI can render an em-dash or hide a
 * panel rather than displaying a misleading $0.00. Omitting a figure is honest;
 * zeroing it is a lie.
 */
export type FinanceRestrictions = {
  trust: AccountLevel;
};

export type InvoiceStatusFilter =
  | "all"
  | "draft"
  | "paid"
  | "unpaid"
  | "partial"
  | "overdue";

export type AccountFilter = "all" | "operating" | "trust";

export type FollowupChannelInput = "email" | "sms" | "both";

export type InvoiceListRow = {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  /**
   * The billed party — a client after conversion, a lead during intake. Named
   * `party` rather than `client` so the UI cannot imply a client relationship
   * that does not exist yet.
   */
  party: InvoiceParty;
  caseId: string | null;
  caseNumber: string | null;
  caseTypeLabel: string | null;
  operatingAmount: number;
  /** Null when the caller has no trust access — never zeroed. */
  trustAmount: number | null;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  status: EffectiveInvoiceStatus;
  /**
   * A one-line summary of the payment schedule, or null when the invoice is due
   * in a single payment.
   *
   * Deliberately a summary rather than the instalments themselves: the list
   * shows "2 of 5 paid · next 1 Oct", and joining the schedule in to build it
   * would multiply every row on the page.
   */
  schedule: {
    count: number;
    paidCount: number;
    nextDueDate: string | null;
  } | null;
};

export type InvoiceStats = {
  invoiceCount: number;
  totalInvoiced: number;
  collected: number;
  collectedCount: number;
  outstanding: number;
  outstandingCount: number;
  overdueCount: number;
  pastDueAmount: number;
  operatingTotal: number;
  trustTotal: number | null;
};

export type AgingBucket = {
  /** "current" | "1-15" | "16-30" | "31+" */
  key: "current" | "1_15" | "16_30" | "31_plus";
  label: string;
  amount: number;
};

export type FinanceActivityEntry = {
  id: string;
  eventType: string;
  title: string;
  description: string | null;
  amount: number | null;
  paymentMethod: PaymentMethod | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  clientName: string | null;
  createdAt: Date;
};

export type TimeEntryRow = {
  id: string;
  staffId: string;
  staffName: string;
  staffRole: string | null;
  caseId: string | null;
  caseNumber: string | null;
  entryDate: string;
  hoursWorked: number;
  billable: boolean;
  amount: number | null;
  status: "pending" | "approved" | "rejected";
  description: string | null;
  /**
   * True when no billing rate could be resolved for this entry. Lets the UI say
   * "set staff rates" instead of rendering a misleading $0.00.
   */
  rateUnset: boolean;
  invoicedAt: Date | null;
};

export type TimeBillingStats = {
  hoursLogged: number;
  billableHours: number;
  totalEarnings: number;
  approvedCount: number;
  pendingCount: number;
  /** billableHours / hoursLogged, as a percentage; 0 when nothing is logged. */
  billableRate: number;
  /** Entries in range that could not resolve a rate. */
  rateUnsetCount: number;
};
