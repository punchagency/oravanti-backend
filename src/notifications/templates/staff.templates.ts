import { html } from "../render";
import type { TemplateDef, TemplateMeta } from "./index";

/**
 * Staff-facing alerts.
 *
 * None of these declare an SMS channel. Alerts about internal state are exactly
 * the traffic that makes a shared sending number look like spam, they carry no
 * urgency a text buys over an email, and every one costs money per recipient
 * per event. Staff who want them on a phone have email on their phone.
 */

const layout = (heading: string, body: string, meta: TemplateMeta) => html`
  <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #1a1a1a; line-height: 1.6;">
    <h2 style="font-size: 18px; margin: 0 0 16px;">${heading}</h2>
    ${{ __raw: body }}
    <p style="color: #666; font-size: 13px; margin-top: 28px;">${meta.firmName}</p>
  </div>
`;

const link = (href: string | undefined, label: string) =>
  href ? html`<p><a href="${href}">${label}</a></p>` : "";

export const staffTemplates = {
  new_lead_submitted: {
    email: (
      ctx: { leadName: string; source?: string; practiceArea?: string; link?: string },
      meta,
    ) => ({
      subject: `New lead: ${ctx.leadName}`,
      html: layout(
        "A new lead came in",
        html`<p><strong>${ctx.leadName}</strong> submitted an enquiry.</p>` +
          (ctx.practiceArea ? html`<p><strong>Matter:</strong> ${ctx.practiceArea}</p>` : "") +
          (ctx.source ? html`<p><strong>Source:</strong> ${ctx.source}</p>` : "") +
          link(ctx.link, "Open lead"),
        meta,
      ),
    }),
    inApp: (ctx: { leadName: string; link?: string }) => ({
      title: "New lead submitted",
      body: `${ctx.leadName} submitted an enquiry`,
      href: ctx.link,
    }),
  },

  task_assigned: {
    email: (
      ctx: { taskTitle: string; assignedBy?: string; dueDate?: string; link?: string },
      meta,
    ) => ({
      subject: `Task assigned: ${ctx.taskTitle}`,
      html: layout(
        "A task was assigned to you",
        html`<p><strong>${ctx.taskTitle}</strong></p>` +
          (ctx.assignedBy ? html`<p><strong>Assigned by:</strong> ${ctx.assignedBy}</p>` : "") +
          (ctx.dueDate ? html`<p><strong>Due:</strong> ${ctx.dueDate}</p>` : "") +
          link(ctx.link, "Open task"),
        meta,
      ),
    }),
    inApp: (ctx: { taskTitle: string; link?: string }) => ({
      title: "Task assigned",
      body: ctx.taskTitle,
      href: ctx.link,
    }),
  },

  case_opened_staff: {
    email: (
      ctx: { caseNumber?: string; clientName?: string; link?: string },
      meta,
    ) => ({
      subject: `Case opened${ctx.caseNumber ? ` — ${ctx.caseNumber}` : ""}`,
      html: layout(
        "A case was opened",
        html`<p>${ctx.clientName ?? "A lead"} has been converted to a case${
          ctx.caseNumber ? html` (${ctx.caseNumber})` : ""
        }.</p>` + link(ctx.link, "Open case"),
        meta,
      ),
    }),
    inApp: (ctx: { caseNumber?: string; clientName?: string; link?: string }) => ({
      title: "Case opened",
      body: `${ctx.clientName ?? "A lead"}${ctx.caseNumber ? ` — ${ctx.caseNumber}` : ""}`,
      href: ctx.link,
    }),
  },

  document_uploaded_staff: {
    email: (
      ctx: { documentTitle: string; uploadedBy?: string; link?: string },
      meta,
    ) => ({
      subject: `Document uploaded: ${ctx.documentTitle}`,
      html: layout(
        "A document was uploaded",
        html`<p><strong>${ctx.documentTitle}</strong>${
          ctx.uploadedBy ? html` from ${ctx.uploadedBy}` : ""
        }</p>` + link(ctx.link, "View document"),
        meta,
      ),
    }),
    inApp: (ctx: { documentTitle: string; link?: string }) => ({
      title: "Document uploaded",
      body: ctx.documentTitle,
      href: ctx.link,
    }),
  },

  fee_agreement_awaiting_firm_signature: {
    email: (ctx: { leadName?: string; link?: string }, meta) => ({
      subject: `Your signature is needed — fee agreement${ctx.leadName ? ` for ${ctx.leadName}` : ""}`,
      html: layout(
        "A fee agreement is waiting for your signature",
        html`<p>${ctx.leadName ?? "A lead"} has signed their fee agreement. It is not executed until you counter-sign it, and no invoice goes out until then.</p>` +
          link(ctx.link, "Review and sign"),
        meta,
      ),
    }),
    inApp: (ctx: { leadName?: string; link?: string }) => ({
      title: "Fee agreement awaiting your signature",
      body: `${ctx.leadName ?? "A lead"} has signed — yours is outstanding`,
      href: ctx.link,
    }),
  },

  fee_agreement_signer_reassigned: {
    email: (ctx: { leadName?: string; link?: string }, meta) => ({
      subject: `You are now signing the fee agreement${ctx.leadName ? ` for ${ctx.leadName}` : ""}`,
      html: layout(
        "You have been assigned a fee agreement to sign",
        html`<p>You are now the firm signer on ${ctx.leadName ?? "a lead"}'s fee agreement.</p>` +
          link(ctx.link, "Open lead"),
        meta,
      ),
    }),
    inApp: (ctx: { leadName?: string; link?: string }) => ({
      title: "Fee agreement signer changed",
      body: `You are now signing for ${ctx.leadName ?? "a lead"}`,
      href: ctx.link,
    }),
  },

  fee_agreement_signed: {
    email: (ctx: { leadName?: string; link?: string }, meta) => ({
      subject: `Fee agreement signed${ctx.leadName ? ` — ${ctx.leadName}` : ""}`,
      html: layout(
        "Fee agreement signed",
        html`<p>${ctx.leadName ?? "A lead"} has signed their fee agreement.</p>` +
          link(ctx.link, "Open lead"),
        meta,
      ),
    }),
    inApp: (ctx: { leadName?: string; link?: string }) => ({
      title: "Fee agreement signed",
      body: `${ctx.leadName ?? "A lead"} signed their fee agreement`,
      href: ctx.link,
    }),
  },

  fee_agreement_declined: {
    email: (ctx: { leadName?: string; reason?: string; link?: string }, meta) => ({
      subject: `Fee agreement declined${ctx.leadName ? ` — ${ctx.leadName}` : ""}`,
      html: layout(
        "Fee agreement declined",
        html`<p>${ctx.leadName ?? "A lead"} declined their fee agreement.</p>` +
          (ctx.reason ? html`<p><strong>Reason given:</strong> ${ctx.reason}</p>` : "") +
          link(ctx.link, "Open lead"),
        meta,
      ),
    }),
    inApp: (ctx: { leadName?: string; link?: string }) => ({
      title: "Fee agreement declined",
      body: `${ctx.leadName ?? "A lead"} declined their fee agreement`,
      href: ctx.link,
    }),
  },

  /*
    Workflow task deadlines.

    Each names the task and its date rather than saying "you have a task due",
    because these arrive in a queue of their own and one that cannot be told
    apart from the last is one nobody opens.
  */
  task_due_soon: {
    email: (ctx: { title?: string; dueDate?: string; link?: string }, meta) => ({
      subject: `Due soon${ctx.title ? ` — ${ctx.title}` : ""}`,
      html: layout(
        "A task is due soon",
        html`<p><strong>${ctx.title ?? "A task"}</strong> is due ${ctx.dueDate ?? "shortly"}.</p>` +
          link(ctx.link, "Open task"),
        meta,
      ),
    }),
    inApp: (ctx: { title?: string; dueDate?: string; link?: string }) => ({
      title: "Task due soon",
      body: `${ctx.title ?? "A task"}${ctx.dueDate ? ` — due ${ctx.dueDate}` : ""}`,
      href: ctx.link,
    }),
  },

  task_overdue: {
    email: (ctx: { title?: string; dueDate?: string; link?: string }, meta) => ({
      subject: `Overdue${ctx.title ? ` — ${ctx.title}` : ""}`,
      html: layout(
        "A task is overdue",
        html`<p><strong>${ctx.title ?? "A task"}</strong> was due ${ctx.dueDate ?? "already"} and is still open.</p>` +
          link(ctx.link, "Open task"),
        meta,
      ),
    }),
    inApp: (ctx: { title?: string; dueDate?: string; link?: string }) => ({
      title: "Task overdue",
      body: `${ctx.title ?? "A task"}${ctx.dueDate ? ` — was due ${ctx.dueDate}` : ""}`,
      href: ctx.link,
    }),
  },

} satisfies Partial<Record<string, TemplateDef>>;
