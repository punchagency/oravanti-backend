/**
 * @openapi
 * tags:
 *   - name: Notifications (webhooks)
 *     description: Provider delivery callbacks — public, signature-verified
 */
import { Router, type Request, type Response } from "express";
import { env } from "../../config/env";
import {
  handleResendWebhook,
  handleTwilioInbound,
  handleTwilioStatusCallback,
} from "../../notifications/notifications.webhooks.service";

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

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
