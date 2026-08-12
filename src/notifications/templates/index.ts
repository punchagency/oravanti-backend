import type { NotificationEventKey } from "../events";
import { consultationTemplates } from "./consultation.templates";
import { financeTemplates } from "./finance.templates";
import { intakeTemplates } from "./intake.templates";
import { staffTemplates } from "./staff.templates";

/**
 * How each event renders on each channel.
 *
 * This is the OTP_EMAIL_CONFIG registry pattern from
 * src/utils/email/email.types.ts, generalised to three channels — a lookup from
 * key to renderer, so adding an event is adding a table entry rather than
 * threading a new branch through a service.
 *
 * A channel with no renderer here is a channel the event cannot use, and the
 * notification is skipped with `no_template` rather than sent empty. The check
 * asserts that every channel an event DECLARES in the catalog has a renderer,
 * so the two cannot drift apart silently.
 */

export type RenderedEmail = { subject: string; html: string };
export type RenderedInApp = { title: string; body: string; href?: string };

export type TemplateMeta = {
  firmName: string;
  recipientName: string;
  /** Frontend base URL, for links staff follow. */
  appUrl: string;
  /** IANA zone the recipient's times should be rendered in. */
  timezone: string;
};

export type TemplateDef = {
  email?: (ctx: any, meta: TemplateMeta) => RenderedEmail;
  sms?: (ctx: any, meta: TemplateMeta) => string;
  inApp?: (ctx: any, meta: TemplateMeta) => RenderedInApp;
};

export const TEMPLATES: Record<NotificationEventKey, TemplateDef> = {
  ...intakeTemplates,
  ...consultationTemplates,
  ...financeTemplates,
  ...staffTemplates,
};
