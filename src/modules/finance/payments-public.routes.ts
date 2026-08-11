/**
 * @openapi
 * tags:
 *   - name: Finance — Payments (public)
 *     description: Token-gated client payment page and provider webhooks
 */
import { Router, type Request, type Response } from "express";
import { sendSuccess } from "../../utils/send-success";
import {
  invoiceByPaymentToken,
  startCheckout,
} from "./payment-links.service";
import { handlePaymentWebhook } from "./payment-webhooks.service";

/**
 * Public, unauthenticated finance routes. The token IS the credential, exactly
 * as it is for consultation booking, document requests and agreement signing.
 *
 * No `requireAuth`, and therefore no request context — which means the `db`
 * proxy falls back to `systemDb` and RLS does not apply on anything these
 * reach. The services below scope every query by the token or by the
 * organization resolved from the invoice, never by ambient tenancy.
 */
export class PaymentPublicRouter {
  public router: Router;
  public path: string;

  constructor() {
    this.router = Router();
    this.path = "/invoice-payment";
    this.initializeRoutes();
  }

  private initializeRoutes() {
    /**
     * @openapi
     * /invoice-payment/{token}:
     *   get:
     *     tags: [Finance — Payments (public)]
     *     summary: What this payment link owes — unauthenticated
     *     responses:
     *       200: { description: Invoice summary for the payer }
     *       400: { description: Expired, cancelled, or already paid }
     */
    this.router.get("/:token", async (req: Request, res: Response) => {
      const invoice = await invoiceByPaymentToken(req.params.token as string);
      sendSuccess(res, invoice, "Invoice retrieved");
    });

    /**
     * @openapi
     * /invoice-payment/{token}/checkout:
     *   post:
     *     tags: [Finance — Payments (public)]
     *     summary: Begin payment; refused while no provider is configured
     *     responses:
     *       200: { description: Redirect URL for the payer }
     *       400: { description: Online payment is not available }
     */
    this.router.post("/:token/checkout", async (req: Request, res: Response) => {
      const session = await startCheckout(req.params.token as string);
      sendSuccess(res, session, "Checkout started");
    });
  }
}

/**
 * Provider webhooks, mounted separately so `express.raw` can be applied to this
 * path alone in app.ts — the signature is over the exact bytes sent.
 */
export class PaymentWebhookRouter {
  public router: Router;
  public path: string;

  constructor() {
    this.router = Router();
    this.path = "/webhooks/payments";
    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.post("/", async (req: Request, res: Response) => {
      const signature =
        (req.headers["stripe-signature"] as string | undefined) ?? "";
      const result = await handlePaymentWebhook(
        req.body as Buffer,
        signature,
      );
      // 200 on anything we successfully decided about, including a duplicate.
      // A non-2xx tells the provider to retry, and retrying a duplicate would
      // be asking for the same rejection forever. Only an unverifiable payload
      // or a real failure throws, and the error middleware turns those into the
      // 4xx/5xx that does mean "try again".
      res.status(200).json(result);
    });
  }
}
