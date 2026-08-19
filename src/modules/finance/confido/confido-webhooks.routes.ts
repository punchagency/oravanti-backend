import { Request, Response, Router } from "express";
import { createModuleLogger } from "../../../lib/logging/log";
import { receiveConfidoWebhook } from "./confido-webhooks.service";

const log = createModuleLogger("confido-webhooks.routes");

/**
 * `POST /webhooks/confido` — the single Confido endpoint.
 *
 * Public and unauthenticated: the HMAC signature is the only authentication,
 * which is why `receiveConfidoWebhook` verifies before parsing.
 *
 * Confido posts every event type for every firm to one Partner-level URL, so
 * this route is not firm-event-specific — slice 2's transaction events arrive
 * here too and the service dispatches on `type`.
 *
 * Answering non-2xx is how Confido learns to retry, so it is reserved for
 * "we genuinely could not accept this". An unrecognised event type is a 200:
 * retrying something we will never handle only burns the retry budget, and
 * repeated failures over 24 hours disable the URL.
 */
export class ConfidoWebhookRouter {
  public router: Router;
  public path: string;

  constructor() {
    this.router = Router();
    this.path = "/webhooks/confido";
    this.router.post("/", this.handle);
  }

  private handle = async (req: Request, res: Response): Promise<void> => {
    // `express.raw` is mounted for this path in app.ts, so the body is the exact
    // bytes Confido signed. Anything else here means the mount was lost.
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ message: "Expected a raw body" });
      return;
    }

    const signature = req.headers["x-signature"];

    try {
      const outcome = await receiveConfidoWebhook(
        req.body,
        typeof signature === "string" ? signature : undefined,
      );
      res.status(200).json(outcome);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Webhook failed";

      // A bad signature is a 401 and stays a 401: it is either an attacker or a
      // secret mismatch, and retrying will not fix either.
      if (message.includes("signature")) {
        res.status(401).json({ message });
        return;
      }
      if (message.includes("not configured") || message.includes("Malformed")) {
        res.status(400).json({ message });
        return;
      }

      // Anything else is ours — a database or Redis failure. 500 so Confido
      // retries, since the event is real and we simply could not take it.
      log.failure("payment.webhook_failed", err, { provider: "confido" });
      res.status(500).json({ message: "Webhook processing failed" });
    }
  };
}

export class ConfidoWebhookModule {
  public router: Router;
  public path: string;

  constructor() {
    const router = new ConfidoWebhookRouter();
    this.router = router.router;
    this.path = router.path;
  }
}
