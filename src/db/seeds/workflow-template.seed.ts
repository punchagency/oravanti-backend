import { db } from "../client";
import { workflowTemplates, workflowModules, workflowTemplateSteps } from "../schema/workflow";
import type { Condition } from "../schema/workflow";
import type { DateAnchor } from "../schema/document-requirements";
import { eq, ilike, inArray, isNull, and } from "drizzle-orm";
import { practiceAreas } from "../schema/practice-areas";
import { practiceAreaSubcategories } from "../schema/practice-area-subcategories";
import { practiceAreaCaseTypes } from "../schema/practice-area-case-types";
import { seedFormEditions } from "./form-editions.seed";
import { seedVisaBulletin } from "./visa-bulletin.seed";
import { seedFilingFees } from "./filing-fees.seed";

/**
 * The four system-default workflow templates, transcribed from
 * `.claude/workflows/04-personal-injury-template.md` and
 * `05-immigration-template.md` — module order, phase, activation type,
 * per-step due-date anchor/offset, and `isLocked` all come from those files'
 * step tables verbatim. Don't "improve" a step's anchor or lock flag here
 * without changing the plan doc first; every one of them traces back to a
 * cited line in the two source legal documents.
 *
 * ─── Step prose is the one deliberate exception ─────────────────────────────
 *
 * The AOS template's step *titles* and the five guidance fields below
 * (`purpose`, `guidance`, `doneWhen`, `pitfalls`, `authority`) are written for
 * the staff member holding the task, not transcribed. The source docs' titles
 * are compressed planning notes — "Screen risk flags → attorney-review flag" —
 * which are fine in a spec and useless on a queue at 4pm.
 *
 * What did NOT change in that pass: module order, phase, activation type and
 * condition, every `dueDateAnchor`/`dueDateOffsetDays`, every `isLocked`, and
 * every `assignableRoles`. The structure still traces to the source docs line
 * for line; only the words a human reads were rewritten.
 *
 * `authority` cites a statute, regulation or form instruction that actually
 * says the thing, or it is omitted. An invented-but-plausible citation is worse
 * than none, because a paralegal will rely on it.
 *
 * ─── Roles ──────────────────────────────────────────────────────────────────
 *
 * Both plan files take `assignableRoles` from each workflow's "Responsible
 * Party" row (Attorney, Paralegal, Medical Records Paralegal, Case Manager,
 * Investigator, Litigation/Trial Paralegal, Bookkeeper) and flag as an open
 * dependency whether those names exist as real `organization_role.role` rows.
 * **They do not** — the live baseline role pack is `attorney`, `paralegal`,
 * `legal_assistant`, `receptionist`. `pickBestAssignee`'s `hasAnyRole` matches
 * case-insensitively against `member.role` / `staff.role` / a `jobTitle`
 * substring, so a specialization that exists only as a job title still matches
 * via that third clause, while the role names below keep the primary
 * role-column match working. The plan's own instruction on this is to fall
 * back rather than error, so specializations collapse onto their base role:
 *
 *   Attorney                                   → attorney
 *   Paralegal / Medical Records Paralegal /
 *     Litigation Paralegal / Trial Paralegal /
 *     Case Manager                             → paralegal
 *   Investigator / Bookkeeper                  → legal_assistant
 *   Client, Expert                             → omitted (not internal staff;
 *                                                 the plan says an externally
 *                                                 retained party is not a role)
 *
 * ─── Certifications ─────────────────────────────────────────────────────────
 *
 * `requiredCertifications` is `[]` on every step in both templates. 04's
 * governing conventions say so outright for PI, and 05 carries the same rule
 * over ("`requiredCertifications` stays empty throughout — the source doc
 * names no internal staff credential gate; I-693's civil surgeon is an
 * external retained party"). An earlier draft of this file invented
 * credential names ("PI Intake", "Immigration Filing"); those matched no
 * `certifications` row and silently made every step unassignable.
 */

const ATTORNEY = "attorney";
const PARALEGAL = "paralegal";
const LEGAL_ASSISTANT = "legal_assistant";

interface StepDef {
  title: string;
  description?: string;
  /**
   * ─── Staff-facing guidance ────────────────────────────────────────────────
   *
   * See `workflowTemplateSteps` for what each field means and why they are five
   * columns rather than one. Optional everywhere: a step with nothing worth
   * saying under a heading should carry no heading, not filler. Every one of
   * them is copied onto the materialized task.
   *
   * `authority` is the one field with a hard rule — it cites a statute,
   * regulation or form instruction that actually says the thing, or it is
   * omitted. A plausible-looking invented citation is worse than none, because
   * a paralegal will rely on it.
   */
  purpose?: string;
  guidance?: string[];
  doneWhen?: string;
  pitfalls?: string;
  authority?: string;
  orderIndex: number;
  /** Null anchor = genuinely event-triggered or standing; see 04 § Governing conventions. */
  dueDateAnchor?: DateAnchor;
  dueDateOffsetDays?: number;
  /** Statutory / malpractice / trust-accounting exposure only — 04 § Governing conventions. */
  isLocked?: boolean;
  /** Overrides the module's roles for this one step (e.g. attorney-only review gates). */
  assignableRoles?: string[];
}

interface ModuleDef {
  name: string;
  phase: string;
  orderIndex: number;
  activationType: "auto" | "conditional" | "manual";
  /** Human-readable note on when a `manual`/`conditional` module opens — not evaluated. */
  description?: string;
  activationCondition?: Condition;
  assignableRoles: string[];
  steps: StepDef[];
}

interface TemplateDef {
  name: string;
  modules: ModuleDef[];
}

export type { ModuleDef, StepDef, TemplateDef };

// ═══════════════════════════════════════════════════════════════════════════
// Personal Injury — 04-personal-injury-template.md
// ═══════════════════════════════════════════════════════════════════════════

const PI_TEMPLATE: TemplateDef = {
  name: "Personal Injury — Full Case Lifecycle",
  modules: [
    {
      name: "SOL Review & Docketing",
      phase: "Case Opening",
      orderIndex: 1,
      activationType: "auto",
      assignableRoles: [PARALEGAL, ATTORNEY],
      steps: [
        { title: "Determine applicable SOL — Fla. Stat. §95.11(3)(a), 2yr", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 0, isLocked: true },
        { title: "Identify tolling factors: minor / discovery rule / govt defendant", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 0, isLocked: true },
        { title: "Set primary SOL deadline", description: "Records the statute of limitations date for this matter. Every later deadline is measured from it.", orderIndex: 3, dueDateAnchor: "case_opened", dueDateOffsetDays: 0, isLocked: true },
        { title: "SOL reminder — 6 months out", orderIndex: 4, dueDateAnchor: "statute_of_limitations_date", dueDateOffsetDays: -180, isLocked: true },
        { title: "SOL reminder — 3 months out", orderIndex: 5, dueDateAnchor: "statute_of_limitations_date", dueDateOffsetDays: -90, isLocked: true },
        { title: "SOL reminder — 30 days out", orderIndex: 6, dueDateAnchor: "statute_of_limitations_date", dueDateOffsetDays: -30, isLocked: true },
        { title: "Document deadline rationale w/ citations", orderIndex: 7, dueDateAnchor: "case_opened", dueDateOffsetDays: 1 },
        { title: "Attorney review/approval of deadline calendar", orderIndex: 8, dueDateAnchor: "case_opened", dueDateOffsetDays: 2, isLocked: true, assignableRoles: [ATTORNEY] },
      ],
    },
    {
      name: "Government Pre-Suit Notice",
      phase: "Case Opening",
      orderIndex: 2,
      activationType: "conditional",
      description: "Activates when the defendant is a government entity — Fla. Stat. §768.28 pre-suit notice.",
      activationCondition: { field: "personalInjuryDetails.defendantType", op: "eq", value: "government_entity" },
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Calendar 3-year SOL + 3-year pre-suit notice (Fla. Stat. §768.28)", orderIndex: 1, dueDateAnchor: "incident_date", dueDateOffsetDays: 1095, isLocked: true },
      ],
    },
    {
      name: "Evidence Preservation & Spoliation Prevention",
      phase: "Investigation",
      orderIndex: 3,
      activationType: "auto",
      assignableRoles: [ATTORNEY, LEGAL_ASSISTANT],
      steps: [
        { title: "Identify potential evidence holders", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 1 },
        { title: "Send litigation hold / spoliation letters", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 2, isLocked: true },
        { title: "Request preservation: footage, EDR data, logs, incident reports", orderIndex: 3, dueDateAnchor: "case_opened", dueDateOffsetDays: 2, isLocked: true },
        { title: "Photograph and document scene", orderIndex: 4, dueDateAnchor: "case_opened", dueDateOffsetDays: 3 },
        { title: "Preserve client social media; advise client not to post", orderIndex: 5, dueDateAnchor: "case_opened", dueDateOffsetDays: 1 },
        { title: "Subpoena/request 911 calls, CAD reports, dispatch logs", orderIndex: 6, dueDateAnchor: "case_opened", dueDateOffsetDays: 3 },
        { title: "Log preservation requests w/ confirmation", orderIndex: 7, dueDateAnchor: "case_opened", dueDateOffsetDays: 3 },
      ],
    },
    {
      name: "Medical Records & Bills Collection",
      phase: "Investigation",
      orderIndex: 4,
      activationType: "auto",
      assignableRoles: [PARALEGAL],
      steps: [
        { title: "Identify treating providers", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 5 },
        { title: "Send HIPAA records requests", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 7 },
        { title: "Track responses", description: "A standing task: follow up every 14 days until it resolves.", orderIndex: 3, dueDateAnchor: "case_opened", dueDateOffsetDays: 21 },
        { title: "Collect itemized bills, EOBs, payment records", description: "Ongoing throughout treatment.", orderIndex: 4 },
        { title: "Organize records chronologically", description: "Ongoing throughout treatment.", orderIndex: 5 },
        { title: "Obtain radiology images/reports", description: "Ongoing throughout treatment.", orderIndex: 6 },
        { title: "Summarize treatment timeline for attorney", description: "Ongoing throughout treatment.", orderIndex: 7 },
      ],
    },
    {
      name: "Insurance Coverage Investigation",
      phase: "Investigation",
      orderIndex: 5,
      activationType: "auto",
      assignableRoles: [PARALEGAL, ATTORNEY],
      steps: [
        { title: "Identify liability insurer; request dec page", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 7 },
        { title: "Confirm policy limits and effective dates", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 10 },
        { title: "Check client's own PIP/UM/UIM/MedPay/health coverage", orderIndex: 3, dueDateAnchor: "case_opened", dueDateOffsetDays: 10 },
        { title: "UM/UIM stacking analysis if multi-vehicle", orderIndex: 4, dueDateAnchor: "case_opened", dueDateOffsetDays: 14 },
        { title: "Investigate umbrella/excess/CGL policies if applicable", orderIndex: 5, dueDateAnchor: "case_opened", dueDateOffsetDays: 14 },
        { title: "Send coverage preservation letters", orderIndex: 6, dueDateAnchor: "case_opened", dueDateOffsetDays: 10, isLocked: true },
        { title: "Document findings in coverage matrix", orderIndex: 7, dueDateAnchor: "case_opened", dueDateOffsetDays: 14 },
      ],
    },
    {
      name: "Liability Investigation & Fault Analysis",
      phase: "Investigation",
      orderIndex: 6,
      activationType: "auto",
      assignableRoles: [ATTORNEY, LEGAL_ASSISTANT],
      steps: [
        { title: "Obtain and analyze police/incident report", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 14 },
        { title: "Interview client; record signed statement", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 14 },
        { title: "Identify/interview eyewitnesses; signed statements", orderIndex: 3, dueDateAnchor: "case_opened", dueDateOffsetDays: 21 },
        { title: "Retain accident reconstruction expert if disputed", orderIndex: 4, dueDateAnchor: "case_opened", dueDateOffsetDays: 30 },
        { title: "Analyze comparative-negligence exposure (Fla. §768.81)", description: "The usual cadence is 30–60 days; 45 is the midpoint — adjust it to the matter.", orderIndex: 5, dueDateAnchor: "case_opened", dueDateOffsetDays: 45, isLocked: true },
        { title: "Review safety codes / OSHA / industry regs", orderIndex: 6, dueDateAnchor: "case_opened", dueDateOffsetDays: 45 },
        { title: "Prepare written liability analysis memo", orderIndex: 7, dueDateAnchor: "case_opened", dueDateOffsetDays: 45 },
      ],
    },
    {
      name: "Medical Treatment Monitoring & Gaps in Care",
      phase: "Active Treatment",
      orderIndex: 7,
      activationType: "auto",
      assignableRoles: [PARALEGAL],
      steps: [
        { title: "Establish monthly client check-in schedule", description: "Standing — monthly throughout active treatment.", orderIndex: 1 },
        { title: "Flag treatment gaps >30 days; counsel client", description: "Standing. Locked: a missed gap-in-care flag directly damages case value at demand time.", orderIndex: 2, isLocked: true },
        { title: "Confirm client treating with appropriate specialists", description: "Standing.", orderIndex: 3 },
        { title: "Request updated records every 60-90 days", description: "Standing.", orderIndex: 4 },
        { title: "Coordinate IME scheduling if required by insurer", description: "Standing.", orderIndex: 5 },
        { title: "Monitor work capacity; collect wage verification", description: "Standing.", orderIndex: 6 },
        { title: "Document treatment-related communications", description: "Standing.", orderIndex: 7 },
      ],
    },
    {
      name: "Damages Calculation & Case Valuation",
      phase: "Pre-Demand",
      orderIndex: 8,
      activationType: "auto",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Confirm MMI with treating physician; obtain MMI letter", description: "No due date, by design: this is the step that records the MMI date, so it cannot be scheduled from it.", orderIndex: 1, isLocked: true },
        { title: "Calculate economic damages: bills, wages, earning capacity", orderIndex: 2, dueDateAnchor: "mmi_date", dueDateOffsetDays: 10 },
        { title: "Identify non-economic damages", orderIndex: 3, dueDateAnchor: "mmi_date", dueDateOffsetDays: 10 },
        { title: "Retain vocational expert if permanent restrictions issued", orderIndex: 4, dueDateAnchor: "mmi_date", dueDateOffsetDays: 15 },
        { title: "Retain life care planner for catastrophic/permanent cases", orderIndex: 5, dueDateAnchor: "mmi_date", dueDateOffsetDays: 15 },
        { title: "Present-value calc with economist if appropriate", orderIndex: 6, dueDateAnchor: "mmi_date", dueDateOffsetDays: 20 },
        { title: "Prepare comprehensive damages summary spreadsheet", orderIndex: 7, dueDateAnchor: "mmi_date", dueDateOffsetDays: 30, isLocked: true },
      ],
    },
    {
      name: "Demand Package Preparation & Submission",
      phase: "Pre-Litigation",
      orderIndex: 9,
      activationType: "auto",
      assignableRoles: [ATTORNEY],
      steps: [
        { title: "Draft demand letter: liability, negligence, causation", orderIndex: 1, dueDateAnchor: "mmi_date", dueDateOffsetDays: 40 },
        { title: "Attach medical records, bills, wage documentation", orderIndex: 2, dueDateAnchor: "mmi_date", dueDateOffsetDays: 45 },
        { title: "Include client-impact narrative", orderIndex: 3, dueDateAnchor: "mmi_date", dueDateOffsetDays: 45 },
        { title: "State demand amount with supporting rationale", orderIndex: 4, dueDateAnchor: "mmi_date", dueDateOffsetDays: 50, isLocked: true },
        { title: "Send via certified mail + email; obtain delivery confirmation", description: "Records the date the demand went out. The usual cadence is 45–60 days from MMI; 52 is the midpoint — adjust it to the matter.", orderIndex: 5, dueDateAnchor: "mmi_date", dueDateOffsetDays: 52, isLocked: true },
        { title: "Set 30-day response-window follow-up (or Fla. §627.736 PIP)", orderIndex: 6, dueDateAnchor: "demand_sent_date", dueDateOffsetDays: 30, isLocked: true },
        { title: "Log submission; begin response-timeline tracking", orderIndex: 7, dueDateAnchor: "demand_sent_date", dueDateOffsetDays: 0 },
      ],
    },
    {
      name: "Settlement Negotiation & Authority Management",
      phase: "Pre-Litigation",
      orderIndex: 10,
      activationType: "auto",
      assignableRoles: [ATTORNEY],
      steps: [
        { title: "Review insurer's initial response with attorney", description: "Event-triggered — depends on the insurer's own timing.", orderIndex: 1 },
        { title: "Prepare settlement authority memo for client", orderIndex: 2 },
        { title: "Obtain client's written authority range", orderIndex: 3, isLocked: true },
        { title: "Counter with written response; log negotiations", orderIndex: 4 },
        { title: "Explore mediation if near impasse", orderIndex: 5 },
        { title: "Evaluate bad-faith exposure if insurer delays/lowballs", description: "Escalate if there is still no resolution 60 days after the demand went out.", orderIndex: 6, dueDateAnchor: "demand_sent_date", dueDateOffsetDays: 60, isLocked: true },
        { title: "If settled: confirm authority, execute releases, begin resolution", orderIndex: 7, isLocked: true },
      ],
    },
    {
      name: "Filing Complaint & Service of Process",
      phase: "Litigation",
      orderIndex: 11,
      activationType: "manual",
      description: "Activated when settlement negotiations fail, or when the statute of limitations requires filing. Litigation is not the default path — most personal injury matters resolve at the demand and negotiation stages.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Draft complaint: negligence, damages, jury demand", orderIndex: 1, dueDateAnchor: "statute_of_limitations_date", dueDateOffsetDays: -60, isLocked: true },
        { title: "File complaint in appropriate court", orderIndex: 2, dueDateAnchor: "statute_of_limitations_date", dueDateOffsetDays: -60, isLocked: true },
        { title: "Pay filing fees; obtain summons per defendant", orderIndex: 3, dueDateAnchor: "statute_of_limitations_date", dueDateOffsetDays: -55 },
        { title: "Serve defendants; retain proof-of-service affidavits", orderIndex: 4, dueDateAnchor: "statute_of_limitations_date", dueDateOffsetDays: -45, isLocked: true },
        { title: "Confirm service; calendar defendant's 20-day answer deadline (Fla. R. Civ. P.)", description: "Records the defendant's answer deadline, once service is actually confirmed.", orderIndex: 5, dueDateAnchor: "defendant_answer_date", dueDateOffsetDays: 0, isLocked: true },
        { title: "File proof of service with court", orderIndex: 6, dueDateAnchor: "defendant_answer_date", dueDateOffsetDays: -15 },
        { title: "Open litigation section of file; notify client", orderIndex: 7 },
      ],
    },
    {
      name: "Discovery Planning & Execution",
      phase: "Litigation – Discovery",
      orderIndex: 12,
      activationType: "manual",
      description: "Activated once the defendant has answered. Cadence otherwise follows the court's scheduling order.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Prepare discovery plan: interrogatories, RFPs, RFAs, depositions", orderIndex: 1, dueDateAnchor: "defendant_answer_date", dueDateOffsetDays: 0 },
        { title: "Serve initial written discovery within 30d of answer", orderIndex: 2, dueDateAnchor: "defendant_answer_date", dueDateOffsetDays: 30, isLocked: true },
        { title: "Review defendant's responses; note deficiencies", orderIndex: 3 },
        { title: "File motions to compel if necessary", orderIndex: 4 },
        { title: "Schedule depositions incl. corporate rep (Rule 1.310(b)(6))", orderIndex: 5 },
        { title: "Respond to defendant's written discovery", description: "Locked even though it carries no fixed due date: the deadline depends on when the defendant serves, and a missed discovery response is real malpractice exposure.", orderIndex: 6, isLocked: true },
        { title: "Organize discovery into indexed folder structure", orderIndex: 7 },
      ],
    },
    {
      name: "Expert Witness Retention & Disclosure",
      phase: "Litigation – Discovery",
      orderIndex: 13,
      activationType: "manual",
      description: "Activated alongside discovery once experts are needed.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Identify required experts", orderIndex: 1, dueDateAnchor: "defendant_answer_date", dueDateOffsetDays: 30 },
        { title: "Retain experts; execute engagement letters", orderIndex: 2, dueDateAnchor: "defendant_answer_date", dueDateOffsetDays: 45 },
        { title: "Provide case materials; schedule review calls", orderIndex: 3, dueDateAnchor: "defendant_answer_date", dueDateOffsetDays: 50 },
        { title: "Review expert draft reports", orderIndex: 4, dueDateAnchor: "defendant_answer_date", dueDateOffsetDays: 60 },
        { title: "Finalize and disclose reports (Fla. R. Civ. P. 1.200)", orderIndex: 5, isLocked: true },
        { title: "Prep experts for Daubert; review opposing disclosures", orderIndex: 6 },
        { title: "Calendar expert deposition dates; prep packages", orderIndex: 7 },
      ],
    },
    {
      name: "Deposition Preparation & Defense",
      phase: "Litigation – Discovery",
      orderIndex: 14,
      activationType: "manual",
      description: "Activated once per deposition. The steps carry no fixed due dates: a matter can have several depositions, so there is no single date to schedule them from.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Review case documents with client, 2 sessions min", orderIndex: 1 },
        { title: "Conduct mock deposition session", orderIndex: 2 },
        { title: "Review records, prior statements, social media w/ client", orderIndex: 3 },
        { title: "Advise client on deposition conduct", orderIndex: 4 },
        { title: "Attend deposition; lodge objections", orderIndex: 5, isLocked: true },
        { title: "Order certified transcript; errata review", orderIndex: 6 },
        { title: "Update file with deposition summary and admissions", orderIndex: 7 },
      ],
    },
    {
      name: "Summary Judgment Defense",
      phase: "Litigation – Pre-Trial",
      orderIndex: 15,
      activationType: "manual",
      description: "Opposing-party-initiated; may never occur. Activated when the defendant files for summary judgment.",
      assignableRoles: [ATTORNEY],
      steps: [
        { title: "Calendar 20-day response deadline", orderIndex: 1, dueDateAnchor: "msj_filed_date", dueDateOffsetDays: 20, isLocked: true },
        { title: "Analyze motion and supporting affidavits", orderIndex: 2, dueDateAnchor: "msj_filed_date", dueDateOffsetDays: 10 },
        { title: "Gather controverting evidence", orderIndex: 3, dueDateAnchor: "msj_filed_date", dueDateOffsetDays: 14 },
        { title: "Draft memorandum in opposition", orderIndex: 4, dueDateAnchor: "msj_filed_date", dueDateOffsetDays: 17 },
        { title: "File response with exhibits and expert affidavits", orderIndex: 5, dueDateAnchor: "msj_filed_date", dueDateOffsetDays: 20, isLocked: true },
        { title: "Prepare for and attend MSJ hearing", orderIndex: 6, dueDateAnchor: "msj_filed_date", dueDateOffsetDays: 25 },
        { title: "If denied: continue trial prep; if granted: evaluate appeal", orderIndex: 7, isLocked: true },
      ],
    },
    {
      name: "Mediation Preparation & Attendance",
      phase: "Pre-Trial",
      orderIndex: 16,
      activationType: "manual",
      description: "Activated once mediation is scheduled.",
      assignableRoles: [ATTORNEY],
      steps: [
        { title: "Select qualified mediator (FL Supreme Court certified preferred)", orderIndex: 1, dueDateAnchor: "mediation_scheduled_date", dueDateOffsetDays: -30 },
        { title: "Prepare mediation summary", orderIndex: 2, dueDateAnchor: "mediation_scheduled_date", dueDateOffsetDays: -14 },
        { title: "Prepare mediation exhibits package", orderIndex: 3, dueDateAnchor: "mediation_scheduled_date", dueDateOffsetDays: -14 },
        { title: "Pre-mediation conference with client", orderIndex: 4, dueDateAnchor: "mediation_scheduled_date", dueDateOffsetDays: -7 },
        { title: "Attend mediation", orderIndex: 5, dueDateAnchor: "mediation_scheduled_date", dueDateOffsetDays: 0, isLocked: true },
        { title: "Evaluate mediator's proposal in private caucuses", orderIndex: 6, dueDateAnchor: "mediation_scheduled_date", dueDateOffsetDays: 0 },
        { title: "If settled: confirm terms in writing; calendar execution", orderIndex: 7, dueDateAnchor: "mediation_scheduled_date", dueDateOffsetDays: 1, isLocked: true },
      ],
    },
    {
      name: "Trial Preparation",
      phase: "Trial",
      orderIndex: 17,
      activationType: "manual",
      description: "Activated once a trial date is set.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Prepare trial notebook: witnesses, exhibits, instructions, voir dire", orderIndex: 1, dueDateAnchor: "trial_date", dueDateOffsetDays: -21 },
        { title: "Draft opening statement and closing argument outlines", orderIndex: 2, dueDateAnchor: "trial_date", dueDateOffsetDays: -21 },
        { title: "Prepare direct/cross-examination outlines", orderIndex: 3, dueDateAnchor: "trial_date", dueDateOffsetDays: -18 },
        { title: "File motions in limine", orderIndex: 4, dueDateAnchor: "trial_date", dueDateOffsetDays: -21, isLocked: true },
        { title: "Exchange exhibit list; stipulate to admissibility", orderIndex: 5, dueDateAnchor: "trial_date", dueDateOffsetDays: -18 },
        { title: "Conduct mock trial/focus group if warranted", orderIndex: 6, dueDateAnchor: "trial_date", dueDateOffsetDays: -14 },
        { title: "Coordinate logistics: reporter, exhibits, technology", orderIndex: 7, dueDateAnchor: "trial_date", dueDateOffsetDays: -10 },
      ],
    },
    {
      name: "Jury Selection (Voir Dire)",
      phase: "Trial",
      orderIndex: 18,
      activationType: "manual",
      description: "Activated when the case actually proceeds to trial.",
      assignableRoles: [ATTORNEY],
      steps: [
        { title: "Review juror questionnaires", orderIndex: 1, dueDateAnchor: "trial_date", dueDateOffsetDays: 0 },
        { title: "Prepare voir dire questions targeting bias/connections", orderIndex: 2, dueDateAnchor: "trial_date", dueDateOffsetDays: -3 },
        { title: "Identify sympathetic and adverse jurors", orderIndex: 3, dueDateAnchor: "trial_date", dueDateOffsetDays: 0 },
        { title: "Exercise peremptory and for-cause challenges", orderIndex: 4, dueDateAnchor: "trial_date", dueDateOffsetDays: 0, isLocked: true },
        { title: "Document juror info and selection decisions", orderIndex: 5, dueDateAnchor: "trial_date", dueDateOffsetDays: 0 },
        { title: "Seat jury and alternates", orderIndex: 6, dueDateAnchor: "trial_date", dueDateOffsetDays: 0, isLocked: true },
        { title: "Begin trial with selected jury", orderIndex: 7, dueDateAnchor: "trial_date", dueDateOffsetDays: 0 },
      ],
    },
    {
      name: "Post-Verdict & Judgment Collection",
      phase: "Post-Trial",
      orderIndex: 19,
      activationType: "manual",
      description: "Activated once a verdict is returned.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Review verdict; assess post-trial motions (JNOV/new trial/additur)", orderIndex: 1, dueDateAnchor: "verdict_date", dueDateOffsetDays: 5, isLocked: true },
        { title: "File judgment if not automatically entered", orderIndex: 2, dueDateAnchor: "verdict_date", dueDateOffsetDays: 10 },
        { title: "Evaluate defendant's assets/coverage for collection", orderIndex: 3, dueDateAnchor: "verdict_date", dueDateOffsetDays: 15 },
        { title: "Serve writ of execution/lien/garnishment if unpaid", orderIndex: 4, dueDateAnchor: "verdict_date", dueDateOffsetDays: 30 },
        { title: "Negotiate payment plan or lump-sum payment", orderIndex: 5 },
        { title: "Evaluate appeal; calendar 30-day notice-of-appeal deadline", orderIndex: 6, dueDateAnchor: "verdict_date", dueDateOffsetDays: 30, isLocked: true },
        { title: "Document all collection actions and payments", orderIndex: 7 },
      ],
    },
    {
      name: "Settlement Disbursement & File Closing",
      phase: "Resolution",
      orderIndex: 20,
      activationType: "manual",
      description: "Marking settlement funds as received records the date and opens this stage.",
      assignableRoles: [ATTORNEY, PARALEGAL, LEGAL_ASSISTANT],
      steps: [
        { title: "Deposit settlement funds into firm trust account (IOLTA)", orderIndex: 1, dueDateAnchor: "funds_received_date", dueDateOffsetDays: 1, isLocked: true },
        { title: "Prepare settlement statement: proceeds, fees, costs", orderIndex: 2, dueDateAnchor: "funds_received_date", dueDateOffsetDays: 5 },
        { title: "Negotiate medical liens: Medicare, Medicaid, provider (Fla. §768.76)", orderIndex: 3, dueDateAnchor: "funds_received_date", dueDateOffsetDays: 14, isLocked: true },
        { title: "Obtain lien satisfaction letters", orderIndex: 4, dueDateAnchor: "funds_received_date", dueDateOffsetDays: 21, isLocked: true },
        { title: "Present final settlement statement; obtain client acknowledgment", orderIndex: 5, dueDateAnchor: "funds_received_date", dueDateOffsetDays: 25, isLocked: true },
        { title: "Disburse net client funds", orderIndex: 6, dueDateAnchor: "funds_received_date", dueDateOffsetDays: 30, isLocked: true },
        { title: "Send client closing letter; archive file", orderIndex: 7, dueDateAnchor: "funds_received_date", dueDateOffsetDays: 30 },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// Immigration — 05-immigration-template.md (three separate templates)
// ═══════════════════════════════════════════════════════════════════════════

const AOS_TEMPLATE: TemplateDef = {
  name: "Family-Based Adjustment of Status",
  modules: [
    {
      name: "Intake & Relationship Documentation",
      phase: "Intake",
      orderIndex: 1,
      activationType: "auto",
      description:
        "Establishes who the parties are, proves the family relationship the whole petition rests on, and surfaces anything that would make adjustment the wrong path before the firm commits to it.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        {
          title: "Record the petitioner's identity and basis of citizenship or LPR status",
          description: "Full legal name, date of birth, prior names, and the primary evidence of the petitioner's status.",
          purpose:
            "The petitioner's status decides the shape of the entire case. A U.S. citizen petitioning an immediate relative can file everything at once; a lawful permanent resident puts the beneficiary in a numerically limited preference category that waits for a visa number, often for years.",
          guidance: [
            "Record the petitioner's full legal name, date of birth, and every prior name used.",
            "Establish the basis of status: birth in the United States, naturalization, or lawful permanent residence.",
            "Collect primary evidence of that status — birth certificate, U.S. passport, certificate of naturalization, or permanent resident card.",
            "Ask whether a naturalization application is pending, and record the answer.",
          ],
          doneWhen:
            "Petitioner identity and basis of status are recorded on the matter, with primary evidence of status in the file.",
          pitfalls:
            "A petitioner who naturalizes after filing changes the beneficiary's category — an F2A spouse of an LPR becomes an immediate relative, which removes the visa-number wait entirely. Catch a pending naturalization at intake rather than discovering it a year into a preference-track wait.",
          authority: "INA 201(b), 203(a); 8 CFR 204.1",
          orderIndex: 1,
          dueDateAnchor: "case_opened",
          dueDateOffsetDays: 3,
        },
        {
          title: "Record the beneficiary's identity, aliases, and full entry and status history",
          description: "Every name used, every entry to the U.S., and a mapped chronology of time in and out of status.",
          purpose:
            "Adjustment under INA 245 requires a lawful admission or parole and turns on the beneficiary's history of status. Gaps, unlawful entries, or prior proceedings can bar adjustment outright — and they change the strategy before a single form is drafted.",
          guidance: [
            "Record every name the beneficiary has used, including maiden names and transliteration variants.",
            "Document each entry to the United States: date, place, manner of entry, and the I-94 record.",
            "Map the periods in status and out of status across the entire history, not just the most recent stay.",
            "Note any prior petitions or applications filed for or by the beneficiary, and any contact with immigration court.",
          ],
          doneWhen:
            "A complete chronology from first entry to today is in the file, with I-94 or equivalent records supporting each entry.",
          pitfalls:
            "An entry without inspection generally bars adjustment under INA 245(a), and the matter may need consular processing with a waiver instead. Finding this at the drafting stage rather than at intake wastes the entire packet.",
          authority: "INA 245(a), 245(c); 8 CFR 245.1",
          orderIndex: 2,
          dueDateAnchor: "case_opened",
          dueDateOffsetDays: 3,
        },
        {
          title: "Collect the evidence that proves the qualifying relationship",
          description: "Marriage certificate plus prior-divorce decrees, or birth certificate — plus bona fide marriage evidence where the case is marriage-based.",
          purpose:
            "The I-130 stands or falls on proof that the claimed family relationship is both real and legally valid. This is the evidentiary core of the petition, and everything downstream assumes it holds.",
          guidance: [
            "For a marriage: a certified marriage certificate, plus certified divorce decrees or death certificates terminating every prior marriage of both parties.",
            "For a parent or child: a certified birth certificate showing the relationship.",
            "For a marriage-based matter, gather bona fides across categories — joint finances, shared residence, insurance and beneficiary designations, photographs spanning time, correspondence.",
            "Obtain certified English translations of every document not already in English.",
          ],
          doneWhen:
            "The qualifying relationship is documented with certified primary evidence, every prior marriage is shown terminated, and a marriage-based file carries bona fide evidence from several independent categories.",
          pitfalls:
            "A prior marriage that was never legally terminated makes the current marriage void and the petition unapprovable. Separately, thin bona fide evidence is the single most common cause of a marriage-based RFE — volume from one category does not substitute for breadth across several.",
          authority: "8 CFR 204.2(a); 8 CFR 103.2(b)(3) (translations)",
          orderIndex: 3,
          dueDateAnchor: "case_opened",
          dueDateOffsetDays: 7,
        },
        {
          title: "Screen the file for risk flags and route it to attorney review",
          description: "Prior marriages, immigration violations, unlawful presence, removal history, criminal history.",
          purpose:
            "Some facts change whether adjustment is viable at all — not the paperwork, the strategy. They have to reach an attorney before the firm puts the client on this path, because several of them are permanent bars that no amount of good drafting cures.",
          guidance: [
            "Prior marriages, and in particular any prior marriage-based petition ever filed for or by either party.",
            "Immigration violations: unlawful presence, unauthorized employment, overstay, prior removal, or voluntary departure.",
            "Any criminal history at all — including arrests that produced no conviction, and matters the client believes were expunged or sealed.",
            "Prior findings of fraud or wilful misrepresentation.",
            "Removal proceedings, whether past, pending, or administratively closed.",
            "Document each flag found and hand the file to an attorney for a strategy decision.",
          ],
          doneWhen:
            "Every flag is documented on the matter and an attorney has reviewed and recorded a decision on the adjustment strategy.",
          pitfalls:
            "A prior marriage-based petition found fraudulent permanently bars approval of any future family petition under INA 204(c) — there is no waiver for it. Clients routinely do not volunteer arrests they were told would not matter, so ask specifically rather than generally.",
          authority: "INA 204(c), 212(a)(2), 212(a)(6)(C), 212(a)(9)(B)",
          orderIndex: 4,
          dueDateAnchor: "case_opened",
          dueDateOffsetDays: 5,
          isLocked: true,
        },
        {
          title: "Determine the filing track from the relationship category and the petitioner's status",
          description: "An immediate relative of a U.S. citizen files concurrently; every other preference category files sequentially.",
          purpose:
            "This is the decision the rest of the workflow branches on. It determines whether the I-485 package can be assembled now or must wait for a visa number, and recording it is literally what unlocks the AOS Package Assembly and EAD/Advance Parole modules on this matter.",
          guidance: [
            "Identify the relationship category from the petitioner's status and the relationship claimed.",
            "An immediate relative of a U.S. citizen — spouse, unmarried child under 21, or parent of a citizen aged 21 or over — is not numerically limited, so a visa number is always available: the track is concurrent.",
            "Every other relationship falls into a numbered preference category (F1 through F4) and must wait for its priority date to become current: the track is sequential.",
            "Record the result on the case's immigration details. The workflow reads that field — an answer left only in a note activates nothing.",
          ],
          doneWhen:
            "The filing track is recorded as concurrent or sequential on the case's immigration details, and the dependent modules have unlocked accordingly.",
          pitfalls:
            "Wrong in either direction is expensive. A premature I-485 on a preference matter is rejected outright and the fee is not returned; a sequential track wrongly set on an immediate relative delays the client's work authorization by months for no reason at all.",
          authority: "INA 201(b), 203(a); 8 CFR 245.2(a)(2)(i)(B)",
          orderIndex: 5,
          dueDateAnchor: "case_opened",
          dueDateOffsetDays: 5,
          isLocked: true,
        },
      ],
    },
    {
      name: "I-130 Petition Assembly",
      phase: "Petition Assembly",
      orderIndex: 2,
      activationType: "auto",
      description:
        "Builds the I-130 itself — the petition that establishes the family relationship. It is the foundation filing: the I-485 cannot be approved until this is.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        {
          title: "Draft the I-130 Petition for Alien Relative",
          description: "Relationship type, petitioner and beneficiary information, and every prior petition either party has filed.",
          purpose:
            "The I-130 is what asks USCIS to recognise the family relationship. Its approval is a prerequisite for the green card, and on a sequential matter its filing date sets the priority date that governs how long the beneficiary waits.",
          guidance: [
            "Select the relationship type that matches the evidence collected at intake — not the one the client describes.",
            "Complete petitioner and beneficiary information exactly as it appears on their identity documents, including the address history the form requests.",
            "Disclose every prior petition either party has filed. USCIS already has these records.",
            "Answer every question; use 'N/A' or 'None' rather than leaving a field blank.",
          ],
          doneWhen:
            "The I-130 is drafted in full, matches the identity documents and intake record, and has been reviewed against the evidence in the file.",
          pitfalls:
            "Blank fields are treated as unanswered and draw an RFE or a rejection — a deliberate 'None' is not the same as an omission. Undisclosed prior petitions read as concealment even when the omission was careless.",
          authority: "INA 204; 8 CFR 204.1, 204.2",
          orderIndex: 1,
          dueDateAnchor: "case_opened",
          dueDateOffsetDays: 14,
        },
        {
          title: "Obtain the petitioner's signature in the form USCIS currently accepts",
          description: "Wet or electronic signature, per the policy in force on the filing date.",
          purpose:
            "An unsigned or improperly signed petition is rejected without adjudication. The signature is what makes the filing an act of the petitioner rather than of the firm.",
          guidance: [
            "Confirm the signature format USCIS accepts for this form and filing channel on the date it will actually be filed.",
            "Have the petitioner sign personally — a representative cannot sign the petition on their behalf.",
            "Check that the signature falls inside the signature block and is dated.",
            "Keep the executed original in the file.",
          ],
          doneWhen:
            "A properly executed, dated signature is on the petition in a format USCIS accepts for the filing channel being used.",
          pitfalls:
            "A typed name, a photocopied signature, or a signature that strays outside the block are each grounds for rejection. Rejection returns the whole package and costs the filing date.",
          authority: "8 CFR 103.2(a)(2)",
          orderIndex: 2,
          dueDateAnchor: "case_opened",
          dueDateOffsetDays: 18,
        },
        {
          title: "Reconcile the I-130 filing fee against the current USCIS fee schedule",
          description: "The petitioner pays; no fee waiver is available for the I-130. Take the figure from the current schedule — fees change, so no amount is recorded here.",
          purpose:
            "An incorrect fee causes rejection of the entire package, not a request to top it up. On a sequential matter that also destroys the priority date the filing would have secured.",
          guidance: [
            "Take the fee from the USCIS fee schedule current on the date of filing — never from an amount printed in an older form, a precedent file, or a note.",
            "Confirm the payment method the receiving lockbox or online channel accepts.",
            "Where several forms are filed together, check whether each requires a separate payment instrument.",
            "Record the amount and the payment reference against the matter.",
          ],
          doneWhen:
            "The fee is verified against the current published schedule, paid by an accepted method, and the amount and reference are recorded on the matter.",
          pitfalls:
            "Fee schedules change on USCIS's timetable and there is frequently no grace period. A cheque for last year's amount comes back with the whole package.",
          authority: "8 CFR 103.7; 8 CFR 106",
          orderIndex: 3,
          dueDateAnchor: "case_opened",
          dueDateOffsetDays: 18,
          isLocked: true,
        },
      ],
    },
    {
      name: "AOS Package Assembly (I-485 / I-765 / I-131 / I-864 / I-693)",
      phase: "Petition Assembly",
      orderIndex: 3,
      activationType: "conditional",
      description:
        "Unlocks once the I-485 can actually be filed — immediately on a concurrent filing, or on a sequential one as soon as the priority date is current.",
      /*
       * Both tracks reach this module; they just reach it at different times.
       *
       * A concurrent filing (immediate relative of a U.S. citizen — no numerical
       * limit, so a visa is always available) assembles the I-485 alongside the
       * I-130 from day one. A preference-category filing waits: the I-485 cannot
       * be filed until a visa number is available, which is what
       * `priorityDateIsCurrent` records.
       *
       * Gating on the track alone was the bug — it left every sequential matter
       * with no I-485 package steps at all, at any point in its life, including
       * the month the priority date finally became current.
       *
       * ─── Why these seven anchor on `module_activated` ───────────────────
       *
       * Every other step in this template anchors on `case_opened`, and for an
       * auto module that is right: the work is available from day one. These
       * seven are not. On a concurrent filing the module opens immediately and
       * `module_activated` and `case_opened` are the same day, so nothing
       * changes. On a *sequential* filing the module opens when the priority
       * date becomes current — years later — and `case_opened + 14 days` would
       * land the first task's deadline years in the past the instant it was
       * created, firing an overdue alert for all seven at the moment the work
       * legitimately became possible.
       *
       * The offsets are unchanged. Only what they count from moved.
       */
      activationCondition: {
        anyOf: [
          { field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" },
          { field: "immigrationDetails.priorityDateIsCurrent", op: "eq", value: true },
        ],
      },
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        {
          title: "Draft the I-485 Application to Register Permanent Residence",
          description: "Immigrant category code, priority date, admission record, and the criminal-history and public-charge questions.",
          purpose:
            "The I-485 is the application for the green card itself. Everything else in this package exists to support it.",
          guidance: [
            "Enter the immigrant category code that matches the I-130 relationship — not a code carried over from a similar matter.",
            "Enter the priority date from the I-130 receipt where one has been issued.",
            "Complete the admission record from the I-94 chronology gathered at intake.",
            "Answer the criminal-history and public-charge questions from the intake screening, disclosing everything found.",
            "Answer every question; use 'None' rather than leaving anything blank.",
          ],
          doneWhen:
            "The I-485 is drafted in full, its category code and priority date match the I-130, and its disclosures match the intake screening record.",
          pitfalls:
            "The disclosure questions are where adjustment applications fail. An arrest omitted here that USCIS finds in the background check is treated as misrepresentation — materially worse than the arrest itself would have been.",
          authority: "INA 245; 8 CFR 245.2; INA 212(a)(4) (public charge)",
          orderIndex: 1,
          dueDateAnchor: "module_activated",
          dueDateOffsetDays: 14,
        },
        {
          title: "Draft the I-765 Application for Employment Authorization",
          description: "EAD eligibility category (c)(9), and any prior EAD numbers.",
          purpose:
            "This is what lets the beneficiary work lawfully while the adjustment is pending — often the single change the client feels most immediately, and typically the first tangible result of the filing.",
          guidance: [
            "Use eligibility category (c)(9) — employment authorization for a pending adjustment applicant.",
            "Record any prior EAD numbers; omitting them slows adjudication.",
            "Confirm the biographic details match the I-485 exactly.",
            "Include the photographs and identity evidence the form instructions require.",
          ],
          doneWhen:
            "The I-765 is drafted under category (c)(9), is consistent with the I-485, and carries the required photographs and identity evidence.",
          pitfalls:
            "The wrong eligibility category is the usual defect here, and it produces a denial of the I-765 rather than an RFE — the client waits months more for work authorization while the adjustment itself proceeds normally.",
          authority: "8 CFR 274a.12(c)(9); 8 CFR 274a.13",
          orderIndex: 2,
          dueDateAnchor: "module_activated",
          dueDateOffsetDays: 14,
        },
        {
          title: "Draft the I-131 Application for Advance Parole",
          description: "Intended travel dates, purpose of travel, and any prior advance parole.",
          purpose:
            "Advance parole is what allows the beneficiary to leave the United States and return while the I-485 is pending. Without it, departure abandons the adjustment application.",
          guidance: [
            "State the intended travel dates and purpose. An applicant with no specific plans should still file — the document is protection against an emergency, not a booking.",
            "Record any prior advance parole granted.",
            "Confirm the biographic details match the I-485 and I-765.",
            "Counsel the client in writing that they must not depart until the document is in hand.",
          ],
          doneWhen:
            "The I-131 is drafted and consistent with the rest of the package, and the client has been advised in writing about travel while the application is pending.",
          pitfalls:
            "Departing the U.S. while the I-485 is pending, without advance parole in hand, is treated as abandonment of the application. Clients do this for family emergencies believing a pending application protects them — it does not.",
          authority: "8 CFR 212.5(f); 8 CFR 245.2(a)(4)(ii)",
          orderIndex: 3,
          dueDateAnchor: "module_activated",
          dueDateOffsetDays: 14,
        },
        {
          title: "Assemble the I-864 Affidavit of Support and verify the sponsor qualifies",
          description: "Measure sponsor income against the 125% federal poverty guideline; add a joint sponsor if it falls short.",
          purpose:
            "The I-864 is a legally enforceable contract in which the sponsor accepts financial responsibility for the beneficiary. Without a qualifying one the beneficiary is inadmissible as a likely public charge, and the adjustment cannot be approved.",
          guidance: [
            "Determine household size using the form's definition — it includes the sponsor's dependants and the beneficiary, and is not simply the number of people living in the house.",
            "Compare the sponsor's income to 125% of the federal poverty guideline for that household size, using the guidelines current at filing.",
            "Where income falls short, add a joint sponsor who independently meets the threshold for their own household plus the beneficiary. A joint sponsor's income is not added to the petitioner's.",
            "Collect the supporting evidence the form requires — tax return or transcript for the most recent year, and proof of current employment and income.",
            "An active-duty member of the U.S. armed forces sponsoring a spouse or child qualifies at 100%, not 125%.",
          ],
          doneWhen:
            "The sponsor's qualifying income is documented against the correct threshold for the correct household size, or a qualifying joint sponsor's I-864 is in the packet with its own supporting evidence.",
          pitfalls:
            "Insufficient sponsor income is among the most common RFE triggers on a family-based adjustment. Two specific errors recur: undercounting household size, and assuming a joint sponsor's income can be added to a deficient petitioner's rather than having to qualify on its own.",
          authority: "INA 213A (8 U.S.C. 1183a); 8 CFR 213a.2; 8 U.S.C. 1183a(f)(3) (military 100%)",
          orderIndex: 4,
          dueDateAnchor: "module_activated",
          dueDateOffsetDays: 18,
          isLocked: true,
        },
        {
          title: "Schedule the I-693 civil surgeon examination and track the sealed envelope",
          description: "Record the sealed-envelope tracking ID. An opened envelope is rejected evidence outright.",
          purpose:
            "The medical examination establishes that the beneficiary is not inadmissible on health grounds. It must be performed by a USCIS-designated civil surgeon — an ordinary physician's examination, however thorough, is not acceptable.",
          guidance: [
            "Refer the beneficiary to a USCIS-designated civil surgeon; verify the designation rather than relying on the practice's own description.",
            "Instruct the beneficiary to bring their vaccination records — missing vaccinations are the usual cause of a repeat visit.",
            "Record the sealed-envelope tracking identifier against the matter on receipt.",
            "Warn the client in writing, and confirm the file note, that the envelope must not be opened by anyone.",
          ],
          doneWhen:
            "The examination is completed by a designated civil surgeon and the sealed envelope is in the file, unopened, with its tracking identifier recorded.",
          pitfalls:
            "An opened envelope is rejected outright and the examination must be repeated at the client's cost. The form does not expire on a clock, but it is tied to the application it is filed with — if that application is withdrawn or denied, any new filing needs a new examination.",
          authority: "INA 212(a)(1); 8 CFR 232.1; 8 CFR 245.5",
          orderIndex: 5,
          dueDateAnchor: "module_activated",
          dueDateOffsetDays: 21,
          isLocked: true,
        },
        {
          title: "Verify every form is the edition USCIS will accept on the filing date",
          description: "Check against the edition current on the day the package will be postmarked, not today's.",
          purpose:
            "USCIS rejects a package built on a superseded form edition, sometimes with no grace period at all. The check is cheap; the rejection costs the filing date and, on a sequential matter, the priority date.",
          guidance: [
            "Check the edition date printed on every form in the package against the currently accepted edition.",
            "Check against the edition that will be current on the intended filing date — not the one current on the day the drafting began.",
            "Where an edition changes mid-assembly, rebuild the affected form rather than filing the old one.",
            "Record the verified edition dates against the matter.",
          ],
          doneWhen:
            "Every form in the package is confirmed to be an edition USCIS accepts as of the intended filing date, and the check is recorded.",
          pitfalls:
            "USCIS sometimes accepts only the new edition from the day it publishes it. A package assembled over several weeks can go stale between drafting and postmark, which is exactly why this check sits immediately before filing rather than at drafting.",
          authority: "8 CFR 103.2(a)(1)",
          orderIndex: 6,
          dueDateAnchor: "module_activated",
          dueDateOffsetDays: 24,
          isLocked: true,
        },
        {
          title: "Confirm the package is complete and every fee is reconciled before filing",
          description: "All components present, all signatures executed, all fees taken from the current schedule.",
          purpose:
            "The last gate before the package leaves the firm. Everything caught here is cheap to fix; the same defect caught by the lockbox returns the entire filing.",
          guidance: [
            "Confirm each component is present: I-485, I-765, I-131, I-864 with supporting evidence, the sealed I-693, and the relationship evidence.",
            "Confirm every form carries a properly executed signature.",
            "Take every fee from the current USCIS fee schedule rather than from an amount written into a form or an earlier note.",
            "Confirm the biographic details agree across all forms — a name or date that differs between two forms draws an RFE.",
            "Make a complete copy of the package as filed before it goes.",
          ],
          doneWhen:
            "Every component is present and signed, fees are reconciled against the current schedule, details agree across all forms, and a complete copy of the package as filed is in the file.",
          pitfalls:
            "A rejected package is returned in full and the filing date is lost. On a sequential matter that also forfeits the priority date the filing would have secured, which can mean years.",
          authority: "8 CFR 103.2(a); 8 CFR 103.7, 8 CFR 106 (fees)",
          orderIndex: 7,
          dueDateAnchor: "module_activated",
          dueDateOffsetDays: 25,
          isLocked: true,
        },
      ],
    },
    {
      name: "Filing & Receipt Notices",
      phase: "Filing & Receipt",
      orderIndex: 4,
      activationType: "auto",
      description:
        "Gets the package to the right place and captures what comes back. The receipt notices are what convert a filing into a tracked matter with a priority date and a service centre.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        {
          title: "File the package to the correct USCIS lockbox or online through the organization account",
          description: "Lockbox is determined by the beneficiary's state of residence.",
          purpose:
            "Filing to the wrong location delays the matter by weeks and can cause outright rejection. The filing date is what establishes the priority date and starts every clock in the rest of this workflow.",
          guidance: [
            "Determine the correct lockbox from the beneficiary's state of residence and the forms being filed together.",
            "Confirm the filing address on the day of filing — USCIS moves intake locations with little notice.",
            "Use a trackable delivery method and record the tracking number against the matter.",
            "Record the filing date on the matter. Later deadlines in this workflow are measured from it.",
          ],
          doneWhen:
            "The package is filed to the correct location by a trackable method, and the filing date and tracking number are recorded on the matter.",
          pitfalls:
            "Lockbox addresses change and the published address for a form filed alone often differs from the one for the same form filed concurrently. Verify for this filing, not from memory.",
          authority: "8 CFR 103.2(a)(7)",
          orderIndex: 1,
          dueDateAnchor: "case_opened",
          dueDateOffsetDays: 28,
          isLocked: true,
        },
        {
          title: "Record each form's receipt number from the I-797C notices as they arrive",
          description: "Each form in the package generates its own receipt notice, and they do not arrive together.",
          purpose:
            "The receipt number is how every form is tracked from here on. Without it there is no way to check status, respond to a notice, or prove the filing was made.",
          guidance: [
            "Expect a separate I-797C for each form filed — the I-485, I-765 and I-131 each generate their own.",
            "Record each receipt number against the matter as it arrives rather than waiting for the set.",
            "Note the service centre named on each notice; processing times vary by centre.",
            "Where a receipt has not arrived several weeks after filing, treat that as a signal to check delivery rather than as normal delay.",
          ],
          doneWhen:
            "A receipt number is recorded on the matter for every form filed, along with the service centre handling each.",
          pitfalls:
            "The notices arrive separately over weeks. Filing them away as they come and only reconciling at the end is how a missing receipt goes unnoticed until the client asks about work authorization.",
          authority: "8 CFR 103.2(b)",
          orderIndex: 2,
          dueDateAnchor: "filed_date",
          dueDateOffsetDays: 14,
          isLocked: true,
        },
        {
          title: "Lock the priority date from the I-797C receipt notice",
          description: "Records the priority date on the matter as the receipt establishes it.",
          purpose:
            "The priority date is the beneficiary's place in the queue. On a preference-category matter it governs how long they wait for a visa number, and it is the value the sequential filing track is measured against.",
          guidance: [
            "Take the priority date from the I-130 receipt notice.",
            "Record it on the case's immigration details, where the visa-bulletin sweep reads it.",
            "Confirm it matches the date the petition was received, not the date the notice was issued.",
          ],
          doneWhen:
            "The priority date is recorded on the case's immigration details and matches the I-797C.",
          pitfalls:
            "The priority date and the notice date are different dates printed on the same notice. Recording the notice date silently puts the beneficiary later in the queue than they actually are.",
          authority: "8 CFR 204.1(c); INA 203(e)",
          orderIndex: 3,
          dueDateAnchor: "receipt_date",
          dueDateOffsetDays: 0,
          isLocked: true,
        },
        {
          title: "Project the expected biometrics and combo-card windows from the service centre's timings",
          description: "Sets client expectations from the receiving centre's recent processing history.",
          purpose:
            "Most client anxiety on a pending adjustment is about silence. A projected window, clearly caveated, converts an indefinite wait into an expected one and heads off the status-check calls.",
          guidance: [
            "Take the current published processing times for the service centre named on the receipt notices.",
            "Project the likely biometrics appointment and combo-card windows from them.",
            "Communicate the projection to the client as an estimate, explicitly not a commitment.",
            "Record the projection so a later delay can be measured against something.",
          ],
          doneWhen:
            "Expected windows are projected from the correct service centre's current times, recorded on the matter, and communicated to the client as estimates.",
          pitfalls:
            "Processing times differ substantially between centres and move over the life of a matter. A projection stated as a promise becomes a complaint when the centre slows down.",
          orderIndex: 4,
          dueDateAnchor: "receipt_date",
          dueDateOffsetDays: 1,
        },
      ],
    },
    {
      name: "Biometrics",
      phase: "Biometrics",
      orderIndex: 5,
      activationType: "auto",
      description:
        "Tracks the Application Support Center appointment. Short, but it is the stage where a matter is most commonly lost to simple non-attendance.",
      assignableRoles: [PARALEGAL],
      steps: [
        {
          title: "Track the ASC biometrics appointment notice and confirm the client has it",
          description: "Record the date and location from the I-797C appointment notice.",
          purpose:
            "The appointment notice is sent to the beneficiary and is easily missed or misread. USCIS treats non-attendance as abandonment, so confirming receipt is the substance of this step.",
          guidance: [
            "Record the appointment date and the Application Support Center location from the notice.",
            "Contact the client to confirm they have received it and can attend.",
            "Tell the client what to bring: the appointment notice itself and photo identification.",
            "Where the date is impossible, follow the reschedule instructions on the notice before the appointment date, not after.",
          ],
          doneWhen:
            "The appointment date and location are recorded, and the client has confirmed they have the notice and will attend.",
          pitfalls:
            "The notice goes to the beneficiary, not the firm. A client who has moved, or who does not recognise what the notice is, misses the appointment without ever telling anyone.",
          authority: "8 CFR 103.2(b)(9)",
          orderIndex: 1,
          dueDateAnchor: "receipt_date",
          dueDateOffsetDays: 21,
        },
        {
          title: "Confirm the appointment was attended and update the matter",
          description: "Verify attendance rather than assuming it.",
          purpose:
            "Attendance is the fact the rest of the adjudication depends on. An unverified assumption here surfaces months later as an unexplained denial.",
          guidance: [
            "Contact the client on or immediately after the appointment date to confirm attendance.",
            "Record the confirmation on the matter.",
            "Where the appointment was missed, move immediately to reschedule — the position is far better before USCIS treats it as abandonment than after.",
          ],
          doneWhen:
            "Attendance is confirmed with the client and recorded on the matter, or a missed appointment has been identified and a reschedule started.",
          pitfalls:
            "Silence from a client is not confirmation. This step exists because the cost of assuming attendance and being wrong is the whole application.",
          authority: "8 CFR 103.2(b)(9), (b)(13)",
          orderIndex: 2,
          dueDateAnchor: "biometrics_appointment",
          dueDateOffsetDays: 0,
          isLocked: true,
        },
        {
          title: "Escalate to the attorney queue if the appointment was missed and not rescheduled within 90 days",
          description: "An unaddressed no-show risks administrative closure of the application.",
          purpose:
            "A missed biometrics appointment left unaddressed leads USCIS to deem the application abandoned and deny it. Ninety days is the point at which this stops being an administrative loose end and becomes a matter requiring an attorney's decision.",
          guidance: [
            "Confirm whether the appointment was in fact missed and whether any reschedule was requested.",
            "Assemble the history: the notice date, appointment date, any contact with the client, and any reschedule attempt.",
            "Hand the matter to an attorney with that history attached rather than as a bare flag.",
          ],
          doneWhen:
            "An attorney has the full history and has recorded a decision on how to proceed, or the appointment has been rescheduled and the escalation is moot.",
          pitfalls:
            "Denial for abandonment is far harder to undo than a late reschedule request is to make. The 90-day mark is a backstop, not a target — act on a known no-show immediately.",
          authority: "8 CFR 103.2(b)(13)",
          orderIndex: 3,
          dueDateAnchor: "biometrics_appointment",
          dueDateOffsetDays: 90,
          isLocked: true,
        },
      ],
    },
    {
      name: "EAD / Advance Parole (Combo Card)",
      phase: "EAD/Advance Parole",
      orderIndex: 6,
      activationType: "conditional",
      description:
        "Unlocks with the I-485 package — the I-765 and I-131 are filed alongside the I-485, so they wait on the same gate.",
      // Same condition as the package module, and for the same reason: the
      // I-765/I-131 ride along with the I-485 whenever it goes in.
      activationCondition: {
        anyOf: [
          { field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" },
          { field: "immigrationDetails.priorityDateIsCurrent", op: "eq", value: true },
        ],
      },
      assignableRoles: [PARALEGAL, ATTORNEY],
      steps: [
        {
          title: "Track the EAD and advance parole receipt numbers through to approval",
          description: "The combo card is usually the first tangible result the client sees.",
          purpose:
            "Employment authorization is what lets the client work lawfully while the adjustment is pending. It typically arrives long before the green card and is the outcome the client is waiting on most immediately.",
          guidance: [
            "Record the receipt numbers for the I-765 and I-131 separately — they are adjudicated separately even when a single combo card is issued.",
            "Check status periodically against the projected window rather than waiting for the client to ask.",
            "Where either falls well outside the service centre's published time, treat that as a signal to enquire.",
          ],
          doneWhen:
            "Both applications are tracked to a decision and the outcome is recorded on the matter.",
          pitfalls:
            "The I-765 and I-131 can be adjudicated at different times. Treating a single card as proof both were approved hides a denied component.",
          authority: "8 CFR 274a.13; 8 CFR 212.5(f)",
          orderIndex: 1,
          dueDateAnchor: "receipt_date",
          dueDateOffsetDays: 60,
        },
        {
          title: "Record the combo card's validity dates and the date it arrived",
          description: "Event-triggered — set when the card actually reaches the client.",
          purpose:
            "The card's valid-to date is what the renewal deadline is measured from. Recording it is what schedules the renewal step; without it, that step has no anchor and never becomes due.",
          guidance: [
            "Record the valid-from and valid-to dates exactly as printed on the card.",
            "Record the date the client actually received it.",
            "Confirm the client has the physical card in hand — not that it was reported as mailed.",
            "Check the printed details for errors; a card issued with a wrong name or date needs correcting immediately.",
          ],
          doneWhen:
            "Both validity dates and the arrival date are recorded on the matter, and the client confirms they hold the card.",
          pitfalls:
            "This step has no due date because nothing predicts when a card arrives. That also means nothing chases it — if the valid-to date is never recorded, the renewal step below never acquires a deadline and the gap in work authorization arrives unannounced.",
          orderIndex: 2,
        },
        {
          title: "File the EAD and advance parole renewal while the I-485 is still pending",
          description: "Start 120 days before the card expires.",
          purpose:
            "A lapse in work authorization is a real consequence in the client's life — lost employment, not a paperwork delay. Combo cards issued for a pending adjustment run substantially shorter than the five years once typical, so renewal comes round sooner than clients expect.",
          guidance: [
            "Confirm the I-485 is still pending; a decided application changes the position entirely.",
            "Start the renewal 120 days before the card expires, which is what this step's due date reflects.",
            "Do not rely on an automatic extension carrying the client through — the extension position has changed and should be verified for the filing rather than assumed.",
            "Tell the client's employer nothing without instruction, but make sure the client understands the timing.",
          ],
          doneWhen:
            "The renewal is filed with a receipt recorded, comfortably before the current card expires.",
          pitfalls:
            "A renewal filed late produces an actual gap in work authorization. The automatic-extension rules that once absorbed such delays have changed, so the margin that used to exist should not be assumed.",
          authority: "8 CFR 274a.13(d)",
          orderIndex: 3,
          dueDateAnchor: "card_valid_to",
          dueDateOffsetDays: -120,
          isLocked: true,
        },
      ],
    },
    {
      name: "I-130 Adjudication & RFE Tracking",
      phase: "I-130 Adjudication",
      orderIndex: 7,
      activationType: "auto",
      description: "I-130 adjudication runs 4–14 months, so the steps here carry no fixed deadlines. The only dated element is the response to an RFE.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        {
          title: "Monitor the I-130 status independently of the I-485",
          description: "The I-130 must be approved before the I-485 can be, even on a concurrent filing.",
          purpose:
            "The two applications travel together on a concurrent filing but are adjudicated separately. The I-130's approval is a prerequisite for the I-485's, so its status has to be watched on its own rather than inferred from the adjustment.",
          guidance: [
            "Check the I-130 receipt number's status on its own schedule, not only when something happens on the I-485.",
            "Record any change of status or transfer between service centres.",
            "Where the I-130 falls well outside published processing times, raise it — the delay blocks the adjustment regardless of how the I-485 is progressing.",
          ],
          doneWhen:
            "The I-130 is tracked to a decision and the outcome is recorded on the matter.",
          pitfalls:
            "Adjudication commonly runs many months, so this step carries no fixed deadline. That makes it easy to leave unattended for far longer than intended — it needs a standing habit rather than a due date.",
          authority: "INA 204(b); 8 CFR 204.2",
          orderIndex: 1,
        },
        {
          title: "Log the issue date, type and subject of any RFE or NOID received",
          description: "Logging the issue date and deadline is what schedules the response reminders.",
          purpose:
            "An RFE or NOID carries a hard response deadline, and missing it means denial. Logging the notice is what puts it under the reminder system — the reminders fire at 50%, 75% and 90% of whatever window the notice itself states.",
          guidance: [
            "Record whether it is a Request for Evidence or a Notice of Intent to Deny — the response strategies differ, and a NOID is the more serious.",
            "Record the issue date and the response deadline exactly as the notice states them. Windows vary by notice; do not assume a standard period.",
            "Record precisely what is being asked for, item by item.",
            "Get it in front of an attorney early — a NOID in particular signals USCIS is disposed to refuse.",
          ],
          doneWhen:
            "The notice type, issue date, stated deadline and each item requested are recorded on the matter, and the reminders are scheduled.",
          pitfalls:
            "The deadline runs from the notice date, not from the day it arrives in the office. Post can consume a meaningful part of a short window before anyone has read the notice.",
          authority: "8 CFR 103.2(b)(8); 8 CFR 103.2(b)(11)",
          orderIndex: 2,
        },
        {
          title: "Submit the RFE or NOID response before the stated deadline",
          description: "Respond to every item in one complete submission.",
          purpose:
            "This is the firm's opportunity to save the petition. USCIS decides on the record as it stands at the deadline — there is no second request, and no extension.",
          guidance: [
            "Respond to every item raised. A partial response is adjudicated as filed and the unanswered items simply fail.",
            "Return the original notice with the response where the notice instructs it.",
            "Send by a trackable method and record proof of timely dispatch.",
            "Submit once and completely — supplements sent after the fact may not reach the adjudicator in time.",
            "File the complete response as submitted.",
          ],
          doneWhen:
            "A complete response to every item is submitted before the deadline, by a trackable method, with proof of dispatch and a full copy in the file.",
          pitfalls:
            "There is no extension available and no second request. An incomplete response is worse than it appears at the time, because the missing item is not flagged — it is simply decided against.",
          authority: "8 CFR 103.2(b)(8), (b)(11), (b)(13)",
          orderIndex: 3,
          isLocked: true,
        },
      ],
    },
    {
      name: "Interview Scheduling & Interview",
      phase: "Interview",
      orderIndex: 8,
      activationType: "auto",
      description:
        "The adjustment interview and everything that has to be true before the client walks in. On a marriage-based matter this is where the bona fides are actually tested.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        {
          title: "Track the interview notice and confirm the client can attend",
          description: "The I-797C interview notice is typically issued 30 to 60 days ahead.",
          purpose:
            "The interview date sets the deadline for every preparation step below it. Recording it is what schedules them; a date left unrecorded leaves the whole preparation sequence undated.",
          guidance: [
            "Record the interview date, time and field office as soon as the notice arrives.",
            "Confirm with the client that they can attend, and that any required party can attend with them.",
            "Note everyone the notice requires to appear — a marriage-based interview generally requires both spouses.",
            "Record the date on the matter so the preparation steps acquire their deadlines.",
          ],
          doneWhen:
            "The interview date, time and location are recorded on the matter and the client has confirmed attendance.",
          pitfalls:
            "Rescheduling an adjustment interview typically adds months and is not granted lightly. Confirm attendance as soon as the notice arrives, while a reschedule request is still realistic.",
          authority: "8 CFR 245.6",
          orderIndex: 1,
          dueDateAnchor: "interview_scheduled_date",
          dueDateOffsetDays: -45,
        },
        {
          title: "Assemble the merged interview document checklist",
          description: "Original filed evidence plus bona fide evidence updated to the present.",
          purpose:
            "The officer tests whether the relationship is genuine now, not only whether it was when the petition was filed. The gap between filing and interview is often more than a year, and evidence from that gap is what carries the interview.",
          guidance: [
            "Assemble originals of every document filed in copy, for inspection at the interview.",
            "Update the bona fide evidence to cover the period since filing — joint finances, shared residence, photographs, correspondence.",
            "Include current identity documents and any document whose validity has changed since filing.",
            "Include evidence of anything that has changed: a move, a new job, a birth.",
            "Produce the checklist for the client in a form they can actually work from.",
          ],
          doneWhen:
            "A complete checklist is prepared covering originals, updated bona fides through to the present, and current identity documents — and the client has it.",
          pitfalls:
            "A file that stops at the filing date is the classic interview weakness. An officer reading eighteen months of nothing draws the obvious inference, whatever the original evidence showed.",
          authority: "8 CFR 245.6; 8 CFR 103.2(b)(5)",
          orderIndex: 2,
          dueDateAnchor: "interview_scheduled_date",
          dueDateOffsetDays: -14,
          isLocked: true,
        },
        {
          title: "Confirm the client's interview preparation is complete",
          description: "The last check before the interview, three days out.",
          purpose:
            "The final gate while there is still time to fix something. A missing document identified three days out is recoverable; the same gap found on the morning is not.",
          guidance: [
            "Confirm the client has every document on the checklist, in original where required.",
            "Confirm the client knows the date, time, location and who must attend.",
            "Walk the client through what the interview will involve and the kind of questions asked.",
            "Confirm attorney attendance where the matter calls for it.",
            "Record the confirmation on the matter.",
          ],
          doneWhen:
            "The client confirms they hold every document and understand the logistics, and the confirmation is recorded.",
          pitfalls:
            "Clients say they have everything without having checked. Ask about specific documents rather than asking whether they are ready.",
          orderIndex: 3,
          dueDateAnchor: "interview_scheduled_date",
          dueDateOffsetDays: -3,
          isLocked: true,
        },
        {
          title: "Attend the interview and record what happened",
          description: "Record the outcome and anything the officer asked to be sent afterwards.",
          purpose:
            "The interview is where the adjustment is usually decided. What the officer said, and anything they asked for, determines what happens next — and is often the only record of it.",
          guidance: [
            "Attend with the client where the matter calls for representation.",
            "Record the outcome: approved, continued pending further evidence, or held for review.",
            "Record precisely anything the officer asked to be submitted afterwards, and the deadline given.",
            "Note any concern the officer raised, in their words rather than paraphrased.",
            "Where anything was requested, act on it immediately — post-interview requests carry short deadlines.",
          ],
          doneWhen:
            "The interview is attended, the outcome is recorded, and any post-interview request is recorded with its deadline and actioned.",
          pitfalls:
            "A request made verbally at the interview is as binding as a written one and is easily lost. Write it down in the room.",
          authority: "8 CFR 245.6; INA 245",
          orderIndex: 4,
          dueDateAnchor: "interview_scheduled_date",
          dueDateOffsetDays: 0,
          isLocked: true,
        },
      ],
    },
    {
      name: "Decision & Card Production",
      phase: "Decision & Card Production",
      orderIndex: 9,
      activationType: "auto",
      description:
        "Records the decision and gets the card into the client's hands. The expiry date captured here is what determines whether this matter ends or continues into removal of conditions.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        {
          title: "Log the decision date, decision type, and any denial reason",
          description: "The decision is the fact everything after it depends on.",
          purpose:
            "Every route available after a decision runs on a deadline measured from the decision date. Recording it accurately is what makes an appeal or a motion possible at all.",
          guidance: [
            "Record the decision date exactly as the notice states it — not the date the notice arrived.",
            "Record the decision type: approved, denied, or administratively closed.",
            "Where denied, record the stated reason in full and in the notice's own words.",
            "Where denied, get the notice in front of an attorney immediately; the response windows are short.",
          ],
          doneWhen:
            "The decision date, type and any stated reason are recorded verbatim on the matter.",
          pitfalls:
            "Appeal and motion deadlines run from the decision date, not from receipt. Paraphrasing a denial reason loses the detail that determines which remedy is actually available.",
          authority: "8 CFR 103.3; 8 CFR 103.5",
          orderIndex: 1,
          dueDateAnchor: "decision_date",
          dueDateOffsetDays: 0,
          isLocked: true,
        },
        {
          title: "Evaluate the available next steps if the application was denied",
          description: "Appeal, motion to reopen or reconsider, refiling, or another path entirely.",
          purpose:
            "A denial is not necessarily the end of the matter, but the remedies carry short deadlines and the choice between them turns on the stated reason. Five days leaves room to decide while every option is still open.",
          guidance: [
            "Read the stated reason closely — it determines which remedies are available.",
            "Consider each: appeal, motion to reopen on new facts, motion to reconsider on legal error, or refiling.",
            "Note the deadline for each option and work back from the earliest.",
            "Check whether the denial affects the beneficiary's status or exposes them to proceedings; that may matter more urgently than the remedy itself.",
            "Advise the client in writing, and record the decision taken.",
          ],
          doneWhen:
            "The options are evaluated against the stated reason, the client is advised in writing, and the chosen route is recorded with its deadline.",
          pitfalls:
            "A denial can leave the beneficiary without status and exposed to removal proceedings. The status consequence is sometimes more urgent than the remedy, and it is easy to miss while focused on the appeal.",
          authority: "8 CFR 103.3 (appeals); 8 CFR 103.5 (motions)",
          orderIndex: 2,
          dueDateAnchor: "decision_date",
          dueDateOffsetDays: 5,
        },
        {
          title: "Track card production and mailing through to delivery",
          description: "Approval is not delivery — follow it until the card is in hand.",
          purpose:
            "A card that is produced but never delivered leaves the client without proof of the status they hold. Cards are lost in the post often enough that this needs following rather than assuming.",
          guidance: [
            "Track the status through card production and mailing.",
            "Confirm with the client that the card physically arrived.",
            "Check the printed details — name, date of birth, category, dates — against the record.",
            "Where the card does not arrive in a reasonable period, or arrives with an error, start the correction process promptly.",
          ],
          doneWhen:
            "The client confirms the card has arrived and its printed details have been checked against the record.",
          pitfalls:
            "An error on the printed card is far easier to correct soon after issue than years later, and a client who does not know to check will not report it.",
          orderIndex: 3,
          dueDateAnchor: "decision_date",
          dueDateOffsetDays: 21,
        },
        {
          title: "Record the green card's expiry date and whether residence is conditional",
          description: "Ten years, or two years where residence is conditional. A two-year card opens the I-751 stage.",
          purpose:
            "This is the branch point at the end of the matter. A ten-year card ends it; a two-year conditional card means a further filing with an absolute deadline, and recording the expiry is what activates that module and schedules its dates.",
          guidance: [
            "Record the expiry date exactly as printed on the card.",
            "Determine whether residence is conditional — it is where the marriage was less than two years old at approval, and the card runs two years rather than ten.",
            "Record the conditional-residence status on the case's immigration details. That field is what unlocks the I-751 module.",
            "Where conditional, tell the client now that a further filing will be required and when.",
          ],
          doneWhen:
            "The expiry date and conditional-residence status are recorded on the case's immigration details, and the I-751 module has unlocked where applicable.",
          pitfalls:
            "If conditional residence is never recorded, the I-751 module never unlocks and nothing in the system will raise the filing window. The client loses their status automatically when the card expires, with no warning from the firm.",
          authority: "INA 216 (8 U.S.C. 1186a); 8 CFR 216.1",
          orderIndex: 4,
          dueDateAnchor: "decision_date",
          dueDateOffsetDays: 0,
          isLocked: true,
        },
      ],
    },
    {
      name: "I-751 Removal of Conditions",
      phase: "Conditions Removal",
      orderIndex: 10,
      activationType: "conditional",
      description: "Unlocks for marriage-based cases approved with a 2-year conditional card.",
      activationCondition: { field: "immigrationDetails.isConditionalResidence", op: "eq", value: true },
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        {
          title: "Begin I-751 preparation as the filing window opens",
          description: "The joint-filing window opens exactly 90 days before the conditional card expires. USCIS rejects an I-751 filed before this date.",
          purpose:
            "The filing window is 90 days and both ends are hard: USCIS rejects a petition filed early, and status terminates automatically if it is filed late. Starting as the window opens is what leaves room to gather evidence without running at the closing date.",
          guidance: [
            "Confirm the exact window from the card's expiry date — it opens 90 days before, and closes on the expiry date itself.",
            "Gather evidence of the marriage covering the two years since conditional residence was granted, not the period before it.",
            "Establish whether this is a joint filing or needs a waiver — divorce, the petitioner's death, or abuse each change the filing and the evidence required.",
            "Confirm the client's current address and marital status before assuming a joint filing.",
          ],
          doneWhen:
            "The window dates are confirmed, the filing basis is established, and evidence covering the conditional period is being assembled.",
          pitfalls:
            "Filing before the window opens gets the petition rejected and returned, which burns time out of a 90-day window. Assuming a joint filing without checking the marriage is still intact is the other common error.",
          authority: "INA 216(d)(2) (8 U.S.C. 1186a(d)(2)); 8 CFR 216.4",
          orderIndex: 1,
          dueDateAnchor: "green_card_expiration_date",
          dueDateOffsetDays: -90,
          isLocked: true,
        },
        {
          title: "File the I-751 — this is the final day of the filing window",
          description: "The window closes on the card's expiration date. There is no grace period.",
          purpose:
            "This is the hardest deadline in the entire workflow. Conditional resident status terminates automatically when the card expires with no petition filed, and removal proceedings follow. It does not require any action by USCIS to happen.",
          guidance: [
            "File before the card's expiration date. This step's due date is the last possible day, not the target.",
            "File by a trackable method and keep proof of timely dispatch.",
            "Record the receipt notice — it extends the client's status while the petition is pending, and they will need it as proof.",
            "Where the deadline has already passed, a late filing must document extraordinary circumstances and their cause; get an attorney onto it immediately.",
          ],
          doneWhen:
            "The I-751 is filed before the expiration date with proof of dispatch, and the receipt notice extending status is recorded and given to the client.",
          pitfalls:
            "Missing this terminates status automatically — no notice, no grace period, and removal proceedings follow. A late filing is accepted only on documented extraordinary circumstances, which is a discretionary remedy and not a fallback to rely on.",
          authority: "INA 216(c)(1), 216(c)(2) (8 U.S.C. 1186a); 8 CFR 216.4(a)(6)",
          orderIndex: 2,
          dueDateAnchor: "green_card_expiration_date",
          dueDateOffsetDays: 0,
          isLocked: true,
        },
      ],
    },
  ],
};

const N400_TEMPLATE: TemplateDef = {
  name: "Naturalization (N-400)",
  modules: [
    {
      name: "Eligibility Screening & Risk Review",
      phase: "Screening",
      orderIndex: 1,
      activationType: "auto",
      description: "The highest-leverage stage in a naturalization matter: every locked step here is a named statutory bar or a ground for outright rejection.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Capture LPR date/basis, all trips abroad (dates, duration, purpose)", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 3 },
        { title: "Check continuous residence and physical presence against the track's thresholds", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 5, isLocked: true },
        { title: "Screen criminal history", description: "All arrests regardless of disposition, including expunged.", orderIndex: 3, dueDateAnchor: "case_opened", dueDateOffsetDays: 5, isLocked: true },
        { title: "Screen good-moral-character bars", description: "Unpaid support, unfiled taxes, false citizenship claims, unlawful voting.", orderIndex: 4, dueDateAnchor: "case_opened", dueDateOffsetDays: 5, isLocked: true },
        { title: "Confirm Selective Service registration if applicable (males 18-25 while in the U.S.)", orderIndex: 5, dueDateAnchor: "case_opened", dueDateOffsetDays: 5, isLocked: true },
        { title: "Confirm tax-filing compliance for all required years", orderIndex: 6, dueDateAnchor: "case_opened", dueDateOffsetDays: 7, isLocked: true },
        { title: "Work out the eligibility date and the earliest filing date; hold intake until the window opens", description: "Five years in general, three where the applicant is married to a U.S. citizen, variable for military service. Filing opens 90 days before the eligibility date.", orderIndex: 7, dueDateAnchor: "case_opened", dueDateOffsetDays: 7, isLocked: true },
      ],
    },
    {
      name: "N-400 Drafting & Document Assembly",
      phase: "Drafting",
      orderIndex: 2,
      activationType: "auto",
      assignableRoles: [PARALEGAL, ATTORNEY],
      steps: [
        { title: "Draft N-400 core application", description: "Biographic, 5yr addresses/employers, family info, criminal-history answers.", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 14 },
        { title: "Attach green card copy (card number, expiration)", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 14 },
        { title: "Attach marriage cert / divorce decrees if 3-year track", orderIndex: 3, dueDateAnchor: "case_opened", dueDateOffsetDays: 14 },
        { title: "Attach tax transcripts if requested", orderIndex: 4, dueDateAnchor: "case_opened", dueDateOffsetDays: 18 },
        { title: "Attach court dispositions for any arrests", orderIndex: 5, dueDateAnchor: "case_opened", dueDateOffsetDays: 18, isLocked: true },
        { title: "Attach passport photos if paper filing", orderIndex: 6, dueDateAnchor: "case_opened", dueDateOffsetDays: 21 },
      ],
    },
    {
      name: "Filing & Receipt",
      phase: "Filing & Receipt",
      orderIndex: 3,
      activationType: "auto",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Confirm today is on or after the earliest filing date before submitting", description: "Gate check — premature filing is an outright rejection.", orderIndex: 1, isLocked: true },
        { title: "File N-400", description: "If a fee waiver is requested, also complete the I-912 income and benefits documentation before the packet is complete. Check the current fees on uscis.gov rather than relying on a figure stated here.", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 28, isLocked: true },
        { title: "Capture receipt number, receipt date, fee paid", orderIndex: 3, dueDateAnchor: "filed_date", dueDateOffsetDays: 14, isLocked: true },
      ],
    },
    {
      name: "Biometrics & Background Checks",
      phase: "Biometrics & Background",
      orderIndex: 4,
      activationType: "auto",
      assignableRoles: [PARALEGAL],
      steps: [
        { title: "Track ASC appointment date/status", orderIndex: 1, dueDateAnchor: "receipt_date", dueDateOffsetDays: 28 },
        { title: "Track name-check status via downstream signals", description: "Opaque to the filer — inferred from other status movement.", orderIndex: 2 },
        { title: "Flag for status inquiry / mandamus screening if no interview notice >12 months post-biometrics", description: "The bridge into the mandamus track.", orderIndex: 3, dueDateAnchor: "biometrics_appointment", dueDateOffsetDays: 365, isLocked: true },
      ],
    },
    {
      name: "Interview, English & Civics Testing",
      phase: "Interview & Testing",
      orderIndex: 5,
      activationType: "auto",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Track interview notice", orderIndex: 1, dueDateAnchor: "interview_scheduled_date", dueDateOffsetDays: -30 },
        { title: "Generate civics study module + document checklist", description: "Civics pool is 128 questions as of the 2025 revision; officers ask up to 20, applicant needs 12 correct.", orderIndex: 2, dueDateAnchor: "interview_scheduled_date", dueDateOffsetDays: -21 },
        { title: "Attend interview; log civics/English test results", orderIndex: 3, dueDateAnchor: "interview_scheduled_date", dueDateOffsetDays: 0, isLocked: true },
        { title: "If failed: calendar retest", description: "The retest window is 60–90 days; 75 is the midpoint — confirm the date on the notice.", orderIndex: 4, dueDateAnchor: "interview_scheduled_date", dueDateOffsetDays: 75 },
        { title: "Track N-648 disability exception if filed", orderIndex: 5 },
      ],
    },
    {
      name: "Decision & Oath",
      phase: "Decision & Oath",
      orderIndex: 6,
      activationType: "auto",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Log decision date and type", orderIndex: 1, dueDateAnchor: "decision_date", dueDateOffsetDays: 0, isLocked: true },
        { title: "If approved: track oath ceremony date, location, certificate number", orderIndex: 2, dueDateAnchor: "oath_ceremony_date", dueDateOffsetDays: 0 },
        { title: "Process name-change request if applicable", orderIndex: 3, dueDateAnchor: "oath_ceremony_date", dueDateOffsetDays: 0 },
      ],
    },
    {
      name: "N-336 Hearing Request",
      phase: "Post-Decision",
      orderIndex: 7,
      activationType: "manual",
      description: "Activated when a decision comes back denied. Started by hand, since a denial is an outcome rather than something known at intake.",
      assignableRoles: [ATTORNEY],
      steps: [
        { title: "File N-336 request for hearing on denial", description: "Generally due within 30 days of the decision. Confirm the current regulatory deadline before relying on this figure.", orderIndex: 1, dueDateAnchor: "decision_date", dueDateOffsetDays: 30, isLocked: true },
      ],
    },
  ],
};

const MANDAMUS_TEMPLATE: TemplateDef = {
  name: "Writ of Mandamus",
  modules: [
    {
      name: "Delay Diagnosis & Candidacy Scoring",
      phase: "Screening",
      orderIndex: 1,
      activationType: "auto",
      assignableRoles: [ATTORNEY],
      steps: [
        { title: "Pull parent case's receipt number, filed date, days pending, last action date", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 0 },
        { title: "Compare against published USCIS/NVC processing times for the form/office", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 1 },
        { title: "Draft structured candidacy memo: statutory basis, chronology, recommendation", description: "The attorney's sign-off. Candidacy is a triage score to weigh, never an instruction to file.", orderIndex: 3, dueDateAnchor: "case_opened", dueDateOffsetDays: 2, isLocked: true },
      ],
    },
    {
      name: "Informal Remedies & Demand Letter",
      phase: "Pre-Suit",
      orderIndex: 2,
      activationType: "auto",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Document each attempted remedy before litigation", description: "e-Request, congressional inquiry, AILA liaison, InfoPass. Locked: at least one remedy must be documented before drafting the complaint.", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 7, isLocked: true },
        { title: "Send pre-suit demand letter to Field/Service Center Director (or DOS Chief of Mission)", description: "Records the date the demand letter went out.", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 21 },
        { title: "Track 30-day demand-letter response window", orderIndex: 3, dueDateAnchor: "demand_letter_sent_date", dueDateOffsetDays: 30, isLocked: true },
      ],
    },
    {
      name: "Complaint Drafting",
      phase: "Complaint Drafting",
      orderIndex: 3,
      activationType: "auto",
      assignableRoles: [ATTORNEY],
      steps: [
        { title: "Draft caption & parties", description: "USCIS Director / DHS Secretary / Field Office Director and/or Sec. of State, U.S. AG.", orderIndex: 1, dueDateAnchor: "demand_letter_sent_date", dueDateOffsetDays: 30 },
        { title: "Establish jurisdiction & venue", description: "28 U.S.C. §1331/§1361, 5 U.S.C. §706(1), venue §1391(e).", orderIndex: 2, dueDateAnchor: "demand_letter_sent_date", dueDateOffsetDays: 30, isLocked: true },
        { title: "Draft factual-background chronology", orderIndex: 3, dueDateAnchor: "demand_letter_sent_date", dueDateOffsetDays: 32 },
        { title: "Draft causes of action", description: "APA unreasonable delay; Mandamus Act; optional due process.", orderIndex: 4, dueDateAnchor: "demand_letter_sent_date", dueDateOffsetDays: 32, isLocked: true },
        { title: "Draft prayer for relief", description: "Order compelling adjudication within a specified period.", orderIndex: 5, dueDateAnchor: "demand_letter_sent_date", dueDateOffsetDays: 35 },
        { title: "Assemble exhibits", description: "Receipts, RFE and response copies, inquiry confirmations, hardship documentation. Left unlocked: a missing hardship narrative is a completeness warning, not a bar to filing.", orderIndex: 6, dueDateAnchor: "demand_letter_sent_date", dueDateOffsetDays: 35 },
      ],
    },
    {
      name: "Filing",
      phase: "Filing",
      orderIndex: 4,
      activationType: "auto",
      assignableRoles: [ATTORNEY],
      steps: [
        { title: "File via CM/ECF; pay federal filing fee or file IFP motion", description: "Records the filing date, the docket number and the assigned judge. No fixed due date — it depends on when the court accepts the filing.", orderIndex: 1, isLocked: true },
      ],
    },
    {
      name: "Service of Process",
      phase: "Service",
      orderIndex: 5,
      activationType: "auto",
      description: "FRCP 4(i) fixes the defendant set at exactly three.",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Serve U.S. Attorney for the district", description: "Records the date the U.S. Attorney was served.", orderIndex: 1, dueDateAnchor: "filed_date", dueDateOffsetDays: 7, isLocked: true },
        { title: "Serve U.S. Attorney General, Washington D.C.", description: "Records the date the Attorney General was served.", orderIndex: 2, dueDateAnchor: "filed_date", dueDateOffsetDays: 7, isLocked: true },
        { title: "Serve relevant agency/officer (USCIS Director / DHS Secretary / Sec. of State)", description: "Records the date the agency head was served.", orderIndex: 3, dueDateAnchor: "filed_date", dueDateOffsetDays: 7, isLocked: true },
        { title: "File proof of service; confirm all three defendants served before marking SERVED", description: "Records the date service was complete on all three defendants. The 60-day clock runs from this date, not from any one of the three.", orderIndex: 4, dueDateAnchor: "filed_date", dueDateOffsetDays: 14, isLocked: true },
      ],
    },
    {
      name: "Government Response Window",
      phase: "Government Response",
      orderIndex: 6,
      activationType: "auto",
      description: "The 60-day clock runs from complete service on all three defendants, not from any one individually.",
      assignableRoles: [ATTORNEY],
      steps: [
        { title: "Track 60-day government response deadline (FRCP 12(a)(2)-(3))", orderIndex: 1, dueDateAnchor: "service_completed_date", dueDateOffsetDays: 60, isLocked: true },
        { title: "Monitor for informal resolution", description: "Agency adjudicates + joint stipulation of dismissal.", orderIndex: 2 },
        { title: "If contested: track motion-to-dismiss briefing schedule", orderIndex: 3 },
      ],
    },
    {
      name: "Ruling / Resolution",
      phase: "Resolution",
      orderIndex: 7,
      activationType: "auto",
      assignableRoles: [ATTORNEY],
      steps: [
        { title: "Log ruling date, ruling summary, or settlement terms", description: "Event-triggered.", orderIndex: 1 },
        { title: "Confirm parent case status was synced", description: "The system performs the sync. This step is the confirmation that it happened — there is nothing to re-enter by hand.", orderIndex: 2, isLocked: true },
      ],
    },
    {
      name: "Closure",
      phase: "Closure",
      orderIndex: 8,
      activationType: "auto",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Record closure date, closure type, and link to underlying case outcome", orderIndex: 1, dueDateAnchor: "ruling_date", dueDateOffsetDays: 3, isLocked: true },
      ],
    },
  ],
};

/**
 * The four templates, keyed by the plan section each was transcribed from.
 *
 * Exported so `workflow-template-seed.test.ts` can hold them to the spec —
 * module counts, step counts, the conventions 04 and 05 state once and apply
 * throughout (empty certifications, real role names, conditions only on
 * conditional modules). Every one of these is invisible to the type system
 * and silently wrong at runtime, which is exactly what the test is for.
 */
export const SYSTEM_TEMPLATES = {
  personalInjury: PI_TEMPLATE,
  adjustmentOfStatus: AOS_TEMPLATE,
  naturalization: N400_TEMPLATE,
  mandamus: MANDAMUS_TEMPLATE,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Seeding
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replaces a system-default template's content in place.
 *
 * Safe to re-run while no org has cloned a system default (cloning only
 * happens on a firm's first edit). It deletes and reinserts only rows with
 * `organizationId IS NULL`, so an org-owned clone is never touched — but per
 * `06-rollout-and-testing.md §3`, updating a system default *after* firms
 * exist needs its own versioning story that does not exist yet.
 */
/** Postgres 23503 — the driver surfaces it on `err.cause`, not on `err`. */
function isForeignKeyViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code
    ?? ((err as { cause?: { code?: string } })?.cause)?.code;
  return code === "23503";
}

async function upsertSystemTemplate(caseTypeId: string, caseTypeName: string, template: TemplateDef) {
  const existing = await db
    .select({ id: workflowTemplates.id })
    .from(workflowTemplates)
    .where(and(eq(workflowTemplates.caseTypeId, caseTypeId), isNull(workflowTemplates.organizationId)));

  if (existing.length > 0) {
    // Modules and steps cascade from the template row.
    try {
      await db.delete(workflowTemplates).where(inArray(workflowTemplates.id, existing.map((t) => t.id)));
    } catch (err) {
      // `tasks.workflow_template_step_id` is NO ACTION, so this delete is
      // refused once a live matter has materialized one of these steps. That
      // is the constraint working: a rebuild here would orphan open tasks from
      // the step that explains what they are.
      //
      // Reported and skipped rather than thrown, because one populated case
      // type should not stop the other sixty-nine from being seeded. Skipping
      // leaves this template exactly as it was.
      if (!isForeignKeyViolation(err)) throw err;
      console.error(
        `  SKIPPED "${caseTypeName}" — live matters reference its steps, ` +
          `so this template cannot be rebuilt and was left as it was.`,
      );
      return;
    }
  }

  const [insertedTemplate] = await db
    .insert(workflowTemplates)
    .values({ caseTypeId, name: template.name })
    .returning();

  let stepCount = 0;

  for (const mod of template.modules) {
    const [insertedModule] = await db
      .insert(workflowModules)
      .values({
        templateId: insertedTemplate.id,
        name: mod.name,
        description: mod.description ?? null,
        phase: mod.phase,
        orderIndex: mod.orderIndex,
        activationType: mod.activationType,
        activationCondition: mod.activationCondition ?? null,
      })
      .returning();

    if (mod.steps.length > 0) {
      await db.insert(workflowTemplateSteps).values(
        mod.steps.map((s) => ({
          moduleId: insertedModule.id,
          title: s.title,
          description: s.description ?? null,
          purpose: s.purpose ?? null,
          guidance: s.guidance ?? [],
          doneWhen: s.doneWhen ?? null,
          pitfalls: s.pitfalls ?? null,
          authority: s.authority ?? null,
          orderIndex: s.orderIndex,
          dueDateAnchor: s.dueDateAnchor ?? null,
          dueDateOffsetDays: s.dueDateOffsetDays ?? null,
          isLocked: s.isLocked ?? false,
          // Empty on every step in both templates — see the file header.
          requiredCertifications: [],
          assignableRoles: s.assignableRoles ?? mod.assignableRoles,
        })),
      );
      stepCount += mod.steps.length;
    }
  }

  console.log(
    `  ${template.name} → "${caseTypeName}" (${template.modules.length} modules, ${stepCount} steps)`,
  );
}

/** Resolves one taxonomy leaf by exact name, scoped to a practice area. */
async function findCaseType(practiceAreaLike: string, caseTypeName: string) {
  const [row] = await db
    .select({ id: practiceAreaCaseTypes.id, name: practiceAreaCaseTypes.name })
    .from(practiceAreaCaseTypes)
    .innerJoin(practiceAreaSubcategories, eq(practiceAreaSubcategories.id, practiceAreaCaseTypes.subcategoryId))
    .innerJoin(practiceAreas, eq(practiceAreas.id, practiceAreaSubcategories.practiceAreaId))
    .where(and(ilike(practiceAreas.name, practiceAreaLike), eq(practiceAreaCaseTypes.name, caseTypeName)))
    .limit(1);
  return row ?? null;
}

/**
 * Seeds the four system-default templates from
 * `.claude/workflows/04-*.md` and `05-*.md`.
 *
 * **Immigration** gets three templates keyed to three specific taxonomy
 * leaves, exactly as 05 specifies — Family-Based AOS, N-400, and Mandamus are
 * genuinely different stage maps, not one lifecycle with branches.
 *
 * **Personal Injury** is the one place this deviates from a literal reading of
 * the plan, and deliberately: 04 describes "a single caseTypeId" for PI, but
 * the live taxonomy has 70 PI leaves and no single "Personal Injury" leaf to
 * key on. Every one of them is a PI matter running the same lifecycle the
 * source document describes, so the PI template is seeded for all of them —
 * the alternative (70 case types with no workflow at all) is worse, and
 * `resolveWorkflowTemplateId` looks up strictly by `caseTypeId`, so there is
 * no "practice area default" fallback to lean on instead.
 */
export async function seedWorkflowTemplate() {
  console.log("Seeding system-default workflow templates...\n");

  // ── Personal Injury ───────────────────────────────────────────────────
  const [piArea] = await db
    .select({ id: practiceAreas.id, name: practiceAreas.name })
    .from(practiceAreas)
    .where(ilike(practiceAreas.name, "Personal Injury%"))
    .limit(1);

  if (!piArea) {
    console.error("Personal Injury practice area not found — run the practice-area-taxonomy seed first.");
  } else {
    const subcategories = await db
      .select({ id: practiceAreaSubcategories.id })
      .from(practiceAreaSubcategories)
      .where(eq(practiceAreaSubcategories.practiceAreaId, piArea.id));

    const caseTypes = subcategories.length
      ? await db
          .select({ id: practiceAreaCaseTypes.id, name: practiceAreaCaseTypes.name })
          .from(practiceAreaCaseTypes)
          .where(inArray(practiceAreaCaseTypes.subcategoryId, subcategories.map((s) => s.id)))
      : [];

    console.log(`Personal Injury — ${caseTypes.length} case types:`);
    for (const caseType of caseTypes) {
      await upsertSystemTemplate(caseType.id, caseType.name, PI_TEMPLATE);
    }
    console.log("");
  }

  // ── Immigration: three templates, three specific leaves ───────────────
  const immigrationTargets: { caseTypeName: string; template: TemplateDef }[] = [
    { caseTypeName: "I-485 — Adjustment of Status (Family-Based)", template: AOS_TEMPLATE },
    { caseTypeName: "N-400 — Application for Naturalization", template: N400_TEMPLATE },
    { caseTypeName: "Writ of Mandamus — U.S. District Court", template: MANDAMUS_TEMPLATE },
  ];

  console.log("Immigration — 3 templates:");
  for (const target of immigrationTargets) {
    const caseType = await findCaseType("Immigration%", target.caseTypeName);
    if (!caseType) {
      console.error(`  MISSING taxonomy leaf "${target.caseTypeName}" — skipped.`);
      continue;
    }
    await upsertSystemTemplate(caseType.id, caseType.name, target.template);
  }

  console.log("\nWorkflow templates seeded.");
}

/**
 * The whole workflow system: the reference data the templates read, then the
 * four templates themselves.
 *
 * Bundled because a template without its reference data is not a working
 * workflow, it is a working workflow's shape. The AOS template has a step that
 * says "check every form is the edition USCIS will accept on the filing date" —
 * with an empty `form_editions` table that step has nothing to check against
 * and the one rule allowed to block a filing silently never fires. Same for the
 * fee quotes and the priority-date sweep.
 *
 * ─── Ordering, and why the templates go last ────────────────────────────────
 *
 * The three reference seeds upsert, so they are idempotent anywhere.
 * `seedWorkflowTemplate` is not: it deletes each system template and rebuilds
 * it, and `tasks.workflow_template_step_id` is NO ACTION, so Postgres refuses
 * the delete the moment a live matter has materialized a step. That is the FK
 * doing its job — it is what stops a re-seed from cutting the audit trail out
 * from under open work — but it means a populated case type is reported and
 * skipped rather than updated.
 *
 * So the reference data runs first. On a fresh database the order is
 * immaterial; on a populated one it is the difference between seeding the
 * three tables that *can* be seeded and seeding nothing at all.
 *
 * ─── Updating a template that already has matters on it ─────────────────────
 *
 * There is no mechanism for this. A reconciler existed while the seed and the
 * live database had diverged; both were brought into line and it was deleted
 * rather than kept as dormant machinery. Editing a template under live matters
 * needs a versioning story — publish a revision, leave open matters on the
 * version they started under — and that story does not exist yet. Until it
 * does, treat a template with matters on it as frozen.
 *
 * The individual seeds stay available on their own — `seed-visa-bulletin` in
 * particular is a monthly job and has no business touching the templates.
 */
export async function seedWorkflows() {
  console.log("Seeding the reference data the templates read...\n");
  await seedFormEditions();
  await seedVisaBulletin();
  await seedFilingFees();

  console.log("");
  await seedWorkflowTemplate();

  console.log("\nWorkflow system seeded.");
}
