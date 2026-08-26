import { env } from "../../config/env";
import { NotificationsController } from "./notifications.controller";
import {
  NotificationsRouter,
  ResendWebhookRouter,
  SmsWebhookRouter,
} from "./notifications.routes";
import { NotificationsService } from "./notifications.service";

/**
 * Provider webhooks, one module per provider so each gets its own body parser
 * in app.ts — Twilio needs urlencoded, Resend needs raw, and both must be
 * mounted before express.json().
 */
export class TwilioWebhookModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const router = new SmsWebhookRouter(
      "twilio",
      "/webhooks/twilio",
      () => env.TWILIO_WEBHOOK_BASE_URL,
    );
    this.router = router.router;
    this.path = router.path;
  }
}

/**
 * Mounted alongside Twilio's whatever SMS_PROVIDER says — see SmsWebhookRouter
 * for why an in-flight callback must never hit a 404.
 */
export class TelnyxWebhookModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const router = new SmsWebhookRouter(
      "telnyx",
      "/webhooks/telnyx",
      () => env.TELNYX_WEBHOOK_BASE_URL,
    );
    this.router = router.router;
    this.path = router.path;
  }
}

export class ResendWebhookModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const router = new ResendWebhookRouter();
    this.router = router.router;
    this.path = router.path;
  }
}

/** Authenticated read side: the communications panel. */
export class NotificationsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new NotificationsService();
    const controller = new NotificationsController(service);
    const router = new NotificationsRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
