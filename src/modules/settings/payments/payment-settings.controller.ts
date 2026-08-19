import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import asyncWrap from "../../../utils/asyncWrapper";
import { AppError } from "../../../utils/error/app-error";
import { PaymentDecryptionError } from "../../../utils/payment-crypto";
import { sendSuccess } from "../../../utils/send-success";
import {
  getPaymentAccount,
  getClearingPolicy,
  getSurchargeSettings,
  refreshStatus,
  setClearingPolicy,
  setSurchargeEnabled,
  startOnboardingSession,
} from "./payment-settings.service";
import { listStatementsForOrg } from "../../finance/confido/statements.service";

export class PaymentSettingsController {
  private orgId(): string {
    const { organizationId } = getRequestContext();
    if (!organizationId) {
      throw new AppError("Organization context required", 401, "UNAUTHORIZED");
    }
    return organizationId;
  }

  /**
   * Read-only. Creates nothing — opening the tab must not provision a merchant
   * account as a side effect of looking at it.
   */
  getAccount = asyncWrap(async (_req: Request, res: Response) => {
    const organizationId = this.orgId();
    try {
      const account = await getPaymentAccount(organizationId);
      sendSuccess(res, account, "Payment account retrieved");
    } catch (err) {
      // A stored token we cannot read is an actionable state, not a server
      // fault: the key in force depends on an optional env var, so a deploy can
      // orphan credentials. Tell the firm to reconnect.
      if (err instanceof PaymentDecryptionError) {
        sendSuccess(
          res,
          {
            configured: true,
            state: "token_unreadable",
            status: null,
            isAcceptingPayments: false,
            confidoFirmIdMasked: null,
            onboardingMethod: null,
            bankAccounts: { trust: null, operating: null },
            brandingAppliedAt: null,
            statusCheckedAt: null,
          },
          "Payment account credential could not be read",
        );
        return;
      }
      throw err;
    }
  });

  /**
   * The lazy-creation trigger, and also the 24-hour token refresh — the frontend
   * calls it again when onboarding.js reports its token expiring, so it must be
   * safe to call repeatedly.
   */
  startOnboarding = asyncWrap(async (_req: Request, res: Response) => {
    const { staffId } = getRequestContext();
    const session = await startOnboardingSession(this.orgId(), staffId ?? null);
    sendSuccess(res, session, "Onboarding session started");
  });

  getSurcharge = asyncWrap(async (_req: Request, res: Response) => {
    const settings = await getSurchargeSettings(this.orgId());
    sendSuccess(res, settings, "Surcharge settings retrieved");
  });

  setSurcharge = asyncWrap(async (req: Request, res: Response) => {
    const settings = await setSurchargeEnabled(
      this.orgId(),
      req.body.enabled === true,
    );
    sendSuccess(res, settings, "Surcharge settings saved");
  });

  getClearingPolicy = asyncWrap(async (_req: Request, res: Response) => {
    const settings = await getClearingPolicy(this.orgId());
    sendSuccess(res, settings, "Clearing policy retrieved successfully");
  });

  setClearingPolicy = asyncWrap(async (req: Request, res: Response) => {
    const settings = await setClearingPolicy(this.orgId(), req.body.policy);
    sendSuccess(res, settings, "Clearing policy updated successfully");
  });

  listStatements = asyncWrap(async (_req: Request, res: Response) => {
    const statements = await listStatementsForOrg(this.orgId());
    sendSuccess(res, statements, "Statements retrieved");
  });

  refresh = asyncWrap(async (_req: Request, res: Response) => {
    const account = await refreshStatus(this.orgId());
    sendSuccess(res, account, "Payment account refreshed");
  });
}
