/**
 * @openapi
 * tags:
 *   - name: Notifications (webhooks)
 *     description: Provider delivery callbacks — public, signature-verified
 */
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { env } from "../../config/env";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import {
  handleResendWebhook,
  handleTwilioInbound,
  handleTwilioStatusCallback,
} from "../../notifications/notifications.webhooks.service";
import { NotificationsController } from "./notifications.controller";

/**
 * Provider webhooks. Public and unauthenticated — the SIGNATURE is the
 * credential.
 *
 * No `requireAuth`, and therefore no request context, which means the `db`
 * proxy falls back to `systemDb` and RLS does not apply to anything these
 * reach. The webhook service scopes every write by a provider message id, a
 * normalised phone, or a lowercased email, never by ambient tenancy.
 *
 * Mounted as its own router so app.ts can apply the right body parser to each
 * path: Twilio signs the URL plus sorted FORM params (urlencoded), Resend signs
 * the RAW bytes (raw). Both parsers must precede express.json().
 */
export class TwilioWebhookRouter {
  public router: Router;
  public path: string;

  constructor() {
    this.router = Router();
    this.path = "/webhooks/twilio";
    this.initializeRoutes();
  }

  /**
   * The exact URL Twilio signed. Rebuilt from configuration rather than from
   * the request, because behind a proxy req.protocol reports "http" while
   * Twilio signed "https" — and every legitimate request would then fail
   * verification, looking like an attack rather than a misconfiguration.
   */
  private signedUrl(suffix: string): string {
    const base = env.TWILIO_WEBHOOK_BASE_URL ?? "";
    return `${base}${this.path}${suffix}`;
  }

  private initializeRoutes() {
    /**
     * @openapi
     * /webhooks/twilio/status:
     *   post:
     *     tags: [Notifications (webhooks)]
     *     summary: Twilio delivery status callback
     *     responses:
     *       204: { description: Recorded }
     *       400: { description: Signature could not be verified }
     */
    this.router.post("/status", async (req: Request, res: Response) => {
      const signature =
        (req.headers["x-twilio-signature"] as string | undefined) ?? "";

      await handleTwilioStatusCallback(
        this.signedUrl("/status"),
        (req.body ?? {}) as Record<string, string>,
        signature,
      );

      // 204 on anything we verified, including a status for a message we have
      // no row for. A 4xx would tell Twilio to retry, and retrying an unknown
      // SID means retrying forever.
      res.status(204).end();
    });

    /**
     * @openapi
     * /webhooks/twilio/inbound:
     *   post:
     *     tags: [Notifications (webhooks)]
     *     summary: Inbound SMS — STOP / START / HELP
     *     responses:
     *       200: { description: TwiML response }
     *       400: { description: Signature could not be verified }
     */
    this.router.post("/inbound", async (req: Request, res: Response) => {
      const signature =
        (req.headers["x-twilio-signature"] as string | undefined) ?? "";

      const { reply } = await handleTwilioInbound(
        this.signedUrl("/inbound"),
        (req.body ?? {}) as Record<string, string>,
        signature,
      );

      // TwiML. An empty <Response/> means "received, say nothing back", which
      // is the right answer to a STOP: Twilio's Advanced Opt-Out sends the
      // compliant confirmation, and a second message to someone who just asked
      // us to stop is what they asked us not to do.
      res.type("text/xml").send(
        reply
          ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`
          : `<?xml version="1.0" encoding="UTF-8"?><Response/>`,
      );
    });
  }
}

export class ResendWebhookRouter {
  public router: Router;
  public path: string;

  constructor() {
    this.router = Router();
    this.path = "/webhooks/resend";
    this.initializeRoutes();
  }

  private initializeRoutes() {
    /**
     * @openapi
     * /webhooks/resend:
     *   post:
     *     tags: [Notifications (webhooks)]
     *     summary: Resend email delivery events
     *     responses:
     *       204: { description: Recorded }
     *       400: { description: Signature could not be verified }
     */
    this.router.post("/", async (req: Request, res: Response) => {
      await handleResendWebhook(req.body as Buffer, {
        "svix-id": (req.headers["svix-id"] as string) ?? "",
        "svix-timestamp": (req.headers["svix-timestamp"] as string) ?? "",
        "svix-signature": (req.headers["svix-signature"] as string) ?? "",
      });

      res.status(204).end();
    });
  }
}

/**
 * Authenticated read side of the ledger — the communications panel.
 *
 * Separate from the webhook routers above so it gets the normal auth chain and
 * the ordinary JSON body parser.
 */
/**
 * Gate the ledger on the entity actually being asked about.
 *
 * The communications panel is a per-entity view — a lead, a client, a matter,
 * an invoice — so one blanket resource would be wrong in both directions: it
 * would either lock finance staff out of an invoice's delivery history, or
 * hand anyone who can read leads the firm's entire outbound record.
 *
 * Any single supplied identifier is enough to authorise. The service ANDs its
 * filters, so adding one only ever narrows the result: a caller passing both a
 * lead and an invoice gets a subset of what either permission alone already
 * entitles them to.
 *
 * With no identifier at all the query is precisely "every message this firm
 * has ever sent", which is the audit surface's own reasoning — reading every
 * action a colleague took — so it takes `audit:read` rather than defaulting to
 * whichever resource happens to be listed first.
 */
const requireLedgerRead = (req: Request, res: Response, next: NextFunction) => {
  if (req.query.invoiceId)
    return requirePermission("finance", "read")(req, res, next);
  if (req.query.clientId)
    return requirePermission("clients", "read")(req, res, next);
  if (req.query.caseId)
    return requirePermission("cases", "read")(req, res, next);
  if (req.query.leadId)
    return requirePermission("leads", "read")(req, res, next);
  return requirePermission("audit", "read")(req, res, next);
};

export class NotificationsRouter {
  public router: Router;
  public path: string;
  private controller: NotificationsController;

  constructor(controller: NotificationsController) {
    this.router = Router();
    this.path = "/notifications";
    this.controller = controller;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    /**
     * @openapi
     * /notifications:
     *   get:
     *     tags: [Notifications (webhooks)]
     *     summary: Delivery history for a lead, client, invoice or case
     *     description: >
     *       Includes skipped and failed rows deliberately — those are the
     *       interesting ones. "Skipped — no SMS consent" is the answer to
     *       "why didn't they get the text".
     *     responses:
     *       200:
     *         description: Paginated notifications, newest first
     */
    this.router.get("/", requireLedgerRead, this.controller.list);

    /**
     * @openapi
     * /notifications/capabilities:
     *   get:
     *     tags: [Notifications (webhooks)]
     *     summary: What this deployment can confirm about delivery
     *     responses:
     *       200:
     *         description: Per-channel delivery tracking availability
     */
    // Deployment capability flags, no tenant data — but gated all the same, so
    // the module has no ungated route for the coverage ratchet to grandfather.
    // `leads:read` is the weakest grant any caller of the panel already holds.
    this.router.get(
      "/capabilities",
      requirePermission("leads", "read"),
      this.controller.capabilities,
    );
  }
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
