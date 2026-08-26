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
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Capture petitioner identity, citizenship/LPR basis", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 3 },
        { title: "Capture beneficiary identity, aliases, entry/status history", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 3 },
        { title: "Collect relationship evidence", description: "Marriage cert + prior-divorce decrees, or birth cert + bona fide marriage evidence.", orderIndex: 3, dueDateAnchor: "case_opened", dueDateOffsetDays: 7 },
        { title: "Screen risk flags → attorney-review flag", description: "Prior marriages, immigration violations, unlawful presence, removal history, criminal history.", orderIndex: 4, dueDateAnchor: "case_opened", dueDateOffsetDays: 5, isLocked: true },
        { title: "Determine the filing track from the relationship category and the petitioner's status", description: "An immediate relative of a U.S. citizen files concurrently; every other preference category files sequentially.", orderIndex: 5, dueDateAnchor: "case_opened", dueDateOffsetDays: 5, isLocked: true },
      ],
    },
    {
      name: "I-130 Petition Assembly",
      phase: "Petition Assembly",
      orderIndex: 2,
      activationType: "auto",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Draft I-130", description: "Relationship type, petitioner/beneficiary info, prior petitions filed.", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 14 },
        { title: "Capture signatures (wet or e-sign per current USCIS policy)", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 18 },
        { title: "Reconcile I-130 filing fee", description: "Petitioner pays; no fee waiver is available. Check the current figure on uscis.gov — filing fees change often, so no amount is stated here.", orderIndex: 3, dueDateAnchor: "case_opened", dueDateOffsetDays: 18, isLocked: true },
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
       */
      activationCondition: {
        anyOf: [
          { field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" },
          { field: "immigrationDetails.priorityDateIsCurrent", op: "eq", value: true },
        ],
      },
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Draft I-485", description: "Immigrant category code, priority date, admission record, criminal-history & public-charge questions.", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 14 },
        { title: "Draft I-765", description: "EAD eligibility category (c)(9), prior EAD numbers.", orderIndex: 2, dueDateAnchor: "case_opened", dueDateOffsetDays: 14 },
        { title: "Draft I-131", description: "Advance parole — intended travel dates, trip purpose, prior AP.", orderIndex: 3, dueDateAnchor: "case_opened", dueDateOffsetDays: 14 },
        { title: "Assemble I-864 Affidavit of Support", description: "Sponsor income against the 125% poverty guideline; add a joint sponsor if it falls short. Locked: insufficient sponsor income is a common RFE trigger.", orderIndex: 4, dueDateAnchor: "case_opened", dueDateOffsetDays: 18, isLocked: true },
        { title: "Schedule I-693 civil surgeon exam; track sealed-envelope tracking ID", description: "An opened sealed envelope is rejected evidence outright. The exam does not expire on a clock, but it is tied to the application it is filed with - if that application is withdrawn or denied, a new exam is needed for any new filing.", orderIndex: 5, dueDateAnchor: "case_opened", dueDateOffsetDays: 21, isLocked: true },
        { title: "Check every form is the edition USCIS will accept on the filing date", description: "USCIS rejects a package built on a superseded edition, sometimes with no grace period at all. Check against the edition current on the day it will be postmarked, not today's.", orderIndex: 6, dueDateAnchor: "case_opened", dueDateOffsetDays: 24, isLocked: true },
        { title: "Confirm the packet is complete: all six components check out and fees are reconciled", description: "Fees change on USCIS's schedule - take the current figures from the fee schedule rather than from any amount written into a form or a précis.", orderIndex: 7, dueDateAnchor: "case_opened", dueDateOffsetDays: 25, isLocked: true },
      ],
    },
    {
      name: "Filing & Receipt Notices",
      phase: "Filing & Receipt",
      orderIndex: 4,
      activationType: "auto",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "File to correct USCIS lockbox (by beneficiary state) or online via org account", orderIndex: 1, dueDateAnchor: "case_opened", dueDateOffsetDays: 28, isLocked: true },
        { title: "Capture each form's receipt number (I-797C) as it arrives", description: "Records each receipt number against the matter as it arrives.", orderIndex: 2, dueDateAnchor: "filed_date", dueDateOffsetDays: 14, isLocked: true },
        { title: "Lock the priority date at receipt", orderIndex: 3, dueDateAnchor: "receipt_date", dueDateOffsetDays: 0, isLocked: true },
        { title: "Work out the expected biometrics and combo-card windows from the service centre's past timings", orderIndex: 4, dueDateAnchor: "receipt_date", dueDateOffsetDays: 1 },
      ],
    },
    {
      name: "Biometrics",
      phase: "Biometrics",
      orderIndex: 5,
      activationType: "auto",
      assignableRoles: [PARALEGAL],
      steps: [
        { title: "Track ASC appointment notice (I-797C): date, location", orderIndex: 1, dueDateAnchor: "receipt_date", dueDateOffsetDays: 21 },
        { title: "Confirm appointment attended; update status", orderIndex: 2, dueDateAnchor: "biometrics_appointment", dueDateOffsetDays: 0, isLocked: true },
        { title: "If missed with no reschedule within 90 days: escalate to attorney queue", description: "An unaddressed no-show risks administrative case closure.", orderIndex: 3, dueDateAnchor: "biometrics_appointment", dueDateOffsetDays: 90, isLocked: true },
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
        { title: "Track EAD/AP receipt number and approval", orderIndex: 1, dueDateAnchor: "receipt_date", dueDateOffsetDays: 60 },
        { title: "Record the card's valid-from and valid-to dates and the date it arrived", description: "Event-triggered — set when the card actually arrives.", orderIndex: 2 },
        { title: "File the EAD/AP renewal if the I-485 is still pending", description: "Combo cards for a pending adjustment now run 18 months rather than five years, and the 540-day automatic extension has ended - so a renewal filed late is a real gap in work authorisation, not a paperwork delay. 120 days is the window to start.", orderIndex: 3, dueDateAnchor: "card_valid_to", dueDateOffsetDays: -120, isLocked: true },
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
        { title: "Monitor I-130 status independently", description: "Prerequisite for I-485 approval even when filed concurrently.", orderIndex: 1 },
        { title: "If RFE/NOID issued: log issue date, type, subject", description: "Logging the issue date and the deadline schedules the reminders. They fire at 50%, 75% and 90% of whatever response window the notice itself states.", orderIndex: 2 },
        { title: "Submit RFE/NOID response", orderIndex: 3, isLocked: true },
      ],
    },
    {
      name: "Interview Scheduling & Interview",
      phase: "Interview",
      orderIndex: 8,
      activationType: "auto",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Track interview notice (I-797C), issued ~30-60 days pre-interview", orderIndex: 1, dueDateAnchor: "interview_scheduled_date", dueDateOffsetDays: -45 },
        { title: "Generate merged document checklist", description: "Original evidence + updated bona-fides evidence.", orderIndex: 2, dueDateAnchor: "interview_scheduled_date", dueDateOffsetDays: -14, isLocked: true },
        { title: "Confirm prep checklist complete", orderIndex: 3, dueDateAnchor: "interview_scheduled_date", dueDateOffsetDays: -3, isLocked: true },
        { title: "Attend interview", orderIndex: 4, dueDateAnchor: "interview_scheduled_date", dueDateOffsetDays: 0, isLocked: true },
      ],
    },
    {
      name: "Decision & Card Production",
      phase: "Decision & Card Production",
      orderIndex: 9,
      activationType: "auto",
      assignableRoles: [ATTORNEY, PARALEGAL],
      steps: [
        { title: "Log decision date, type, denial reason if applicable", orderIndex: 1, dueDateAnchor: "decision_date", dueDateOffsetDays: 0, isLocked: true },
        { title: "If denied: evaluate next steps", orderIndex: 2, dueDateAnchor: "decision_date", dueDateOffsetDays: 5 },
        { title: "Track card production and mailing dates", orderIndex: 3, dueDateAnchor: "decision_date", dueDateOffsetDays: 21 },
        { title: "Record the green card's expiry date", description: "10 years, or 2 years where residence is conditional. A conditional card opens the I-751 stage.", orderIndex: 4, dueDateAnchor: "decision_date", dueDateOffsetDays: 0, isLocked: true },
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
        { title: "Begin I-751 preparation — filing window opens", description: "The joint-filing window opens exactly 90 days before the conditional card expires. USCIS rejects an I-751 filed before this date.", orderIndex: 1, dueDateAnchor: "green_card_expiration_date", dueDateOffsetDays: -90, isLocked: true },
        { title: "File I-751 — final day of the filing window", description: "The window closes on the card's expiration date. Miss it and conditional resident status terminates automatically and removal proceedings follow; there is no grace period, and a late filing needs documented extraordinary circumstances.", orderIndex: 2, dueDateAnchor: "green_card_expiration_date", dueDateOffsetDays: 0, isLocked: true },
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
