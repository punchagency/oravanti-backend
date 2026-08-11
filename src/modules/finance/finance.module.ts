import { InvoicesController } from "./invoices.controller";
import { InvoicesRouter } from "./invoices.routes";
import { FinanceReportsController } from "./reports.controller";
import { FinanceReportsRouter } from "./reports.routes";
import { TimeBillingController } from "./time-billing.controller";
import { TimeBillingRouter } from "./time-billing.routes";

/**
 * Three modules from one directory, following the leads module's precedent.
 *
 * The three tabs are three views of one ledger rather than three resources —
 * Reports re-aggregates exactly what the Invoicing tiles aggregate, and Time &
 * Billing feeds the invoice-create flow — so they share `status.ts`,
 * `totals.ts` and `money.ts` rather than duplicating the money SQL. Separate
 * mount paths keep the URLs clean and let permissions differ per tab.
 */

export class InvoicesModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const controller = new InvoicesController();
    const router = new InvoicesRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}

export class TimeBillingModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const controller = new TimeBillingController();
    const router = new TimeBillingRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}

export class FinanceReportsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const controller = new FinanceReportsController();
    const router = new FinanceReportsRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
