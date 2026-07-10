import { db } from "../client";
import { workflowTemplates, workflowModules, workflowTemplateSteps } from "../schema/workflow";
import { eq, ilike } from "drizzle-orm";
import { practiceAreas } from "../schema/practice-areas";

interface StepDef {
  title: string;
  description?: string;
  orderIndex: number;
  dueInDays?: number;
  requiredCertification?: string;
}

interface ModuleDef {
  name: string;
  phase: string;
  orderIndex: number;
  activationType: "auto" | "conditional" | "manual";
  activationCondition?: string;
  steps: StepDef[];
}

interface TemplateDef {
  name: string;
  modules: ModuleDef[];
}

const PI_TEMPLATE: TemplateDef = {
  name: "Personal Injury — Full Case Lifecycle",
  modules: [
    {
      name: "Initial Client Intake & Conflict Check",
      phase: "Pre-Engagement",
      orderIndex: 1,
      activationType: "auto",
      steps: [
        { title: "Receive initial inquiry (phone/web form/walk-in); log date, time, referral source", orderIndex: 1, requiredCertification: "PI Intake" },
        { title: "Conduct 10-minute intake screening: injury type, incident date, parties involved", orderIndex: 2, requiredCertification: "PI Intake" },
        { title: "Run conflict of interest check against firm database", orderIndex: 3, requiredCertification: "PI Intake" },
        { title: "If no conflict: schedule in-depth intake consultation", orderIndex: 4, requiredCertification: "PI Intake" },
        { title: "Collect signed HIPAA authorization, photo ID, insurance cards", orderIndex: 5, requiredCertification: "PI Intake" },
        { title: "Enter all data into case management system; assign case number", orderIndex: 6, requiredCertification: "PI Intake" },
        { title: "Send intake confirmation + client portal access credentials", orderIndex: 7, requiredCertification: "PI Intake" },
      ],
    },
    {
      name: "Statute of Limitations Review & Docketing",
      phase: "Case Opening",
      orderIndex: 2,
      activationType: "auto",
      steps: [
        { title: "Identify applicable statute of limitations", orderIndex: 1, requiredCertification: "PI Intake" },
        { title: "Identify tolling factors: minor plaintiff, discovery rule, government defendant", orderIndex: 2, requiredCertification: "PI Intake" },
        { title: "If government entity: calendar SOL + pre-suit notice requirements", orderIndex: 3, requiredCertification: "PI Intake" },
        { title: "Set primary SOL deadline in case management system", orderIndex: 4, requiredCertification: "PI Intake" },
        { title: "Set 3 warning reminders: 6 months, 3 months, 30 days before SOL", orderIndex: 5, requiredCertification: "PI Intake" },
        { title: "Document deadline rationale in file with statutory citations", orderIndex: 6, requiredCertification: "PI Intake" },
        { title: "Attorney reviews and approves deadline calendar entry", orderIndex: 7, requiredCertification: "PI Intake" },
      ],
    },
    {
      name: "Evidence Preservation & Spoliation Prevention",
      phase: "Investigation",
      orderIndex: 3,
      activationType: "auto",
      steps: [
        { title: "Identify all potential evidence holders", orderIndex: 1, requiredCertification: "PI Intake" },
        { title: "Draft and send litigation hold / spoliation letter", orderIndex: 2, requiredCertification: "PI Intake" },
        { title: "Request preservation of surveillance footage, vehicle EDR data", orderIndex: 3, requiredCertification: "PI Intake" },
        { title: "Photograph and document scene", orderIndex: 4, requiredCertification: "PI Intake" },
        { title: "Preserve client social media", orderIndex: 5, requiredCertification: "PI Intake" },
        { title: "Subpoena or request 911 call recordings, CAD reports", orderIndex: 6, requiredCertification: "PI Intake" },
        { title: "Log all preservation requests with sent date and recipient confirmation", orderIndex: 7, requiredCertification: "PI Intake" },
      ],
    },
    {
      name: "Medical Records & Bills Collection",
      phase: "Investigation",
      orderIndex: 4,
      activationType: "auto",
      steps: [
        { title: "Identify all treating providers", orderIndex: 1, requiredCertification: "PI Medical" },
        { title: "Send HIPAA-compliant medical records requests", orderIndex: 2, requiredCertification: "PI Medical" },
        { title: "Track responses; follow up at 14-day intervals", orderIndex: 3, requiredCertification: "PI Medical" },
        { title: "Collect itemized bills, EOBs, and insurance payment records", orderIndex: 4, requiredCertification: "PI Medical" },
        { title: "Organise records chronologically in case management system", orderIndex: 5, requiredCertification: "PI Medical" },
        { title: "Obtain radiology images and reports separately", orderIndex: 6, requiredCertification: "PI Medical" },
        { title: "Summarize medical treatment timeline for attorney review", orderIndex: 7, requiredCertification: "PI Medical" },
      ],
    },
    {
      name: "Insurance Coverage Investigation",
      phase: "Investigation",
      orderIndex: 5,
      activationType: "auto",
      steps: [
        { title: "Identify defendant's liability insurer; request policy declarations page", orderIndex: 1, requiredCertification: "PI Intake" },
        { title: "Confirm policy limits and coverage effective dates", orderIndex: 2, requiredCertification: "PI Intake" },
        { title: "Check client's own PIP, UM/UIM, MedPay coverage", orderIndex: 3, requiredCertification: "PI Intake" },
        { title: "Request UM/UIM stacking analysis if multiple vehicles", orderIndex: 4, requiredCertification: "PI Litigation" },
        { title: "Investigate umbrella/excess policies", orderIndex: 5, requiredCertification: "PI Intake" },
        { title: "Send coverage preservation letters to all insurers", orderIndex: 6, requiredCertification: "PI Intake" },
        { title: "Document all coverage findings in insurance coverage matrix", orderIndex: 7, requiredCertification: "PI Intake" },
      ],
    },
    {
      name: "Liability Investigation & Fault Analysis",
      phase: "Investigation",
      orderIndex: 6,
      activationType: "auto",
      steps: [
        { title: "Obtain and analyze police/incident reports", orderIndex: 1, requiredCertification: "PI Intake" },
        { title: "Interview client thoroughly; record signed statement", orderIndex: 2, requiredCertification: "PI Intake" },
        { title: "Identify and interview eyewitnesses", orderIndex: 3, requiredCertification: "PI Intake" },
        { title: "Retain accident reconstruction expert if liability is disputed", orderIndex: 4, requiredCertification: "PI Litigation" },
        { title: "Analyze comparative negligence exposure", orderIndex: 5, requiredCertification: "PI Litigation" },
        { title: "Review relevant safety codes and industry regulations", orderIndex: 6, requiredCertification: "PI Litigation" },
        { title: "Prepare written liability analysis memorandum for file", orderIndex: 7, requiredCertification: "PI Litigation" },
      ],
    },
    {
      name: "Medical Treatment Monitoring & Gaps in Care",
      phase: "Active Treatment",
      orderIndex: 7,
      activationType: "auto",
      steps: [
        { title: "Establish monthly check-in schedule with client", orderIndex: 1, requiredCertification: "PI Medical" },
        { title: "Flag gaps in treatment exceeding 30 days", orderIndex: 2, requiredCertification: "PI Medical" },
        { title: "Ensure client is treating with appropriate specialists", orderIndex: 3, requiredCertification: "PI Medical" },
        { title: "Request updated medical records every 60-90 days", orderIndex: 4, requiredCertification: "PI Medical" },
        { title: "Coordinate IME scheduling if required", orderIndex: 5, requiredCertification: "PI Medical" },
        { title: "Monitor client's ability to work; collect wage verification", orderIndex: 6, requiredCertification: "PI Medical" },
        { title: "Document all treatment-related communications", orderIndex: 7, requiredCertification: "PI Medical" },
      ],
    },
    {
      name: "Damages Calculation & Case Valuation",
      phase: "Pre-Demand",
      orderIndex: 8,
      activationType: "auto",
      steps: [
        { title: "Confirm MMI status; obtain formal MMI letter", orderIndex: 1, requiredCertification: "PI Damages" },
        { title: "Calculate economic damages", orderIndex: 2, requiredCertification: "PI Damages" },
        { title: "Identify non-economic damages", orderIndex: 3, requiredCertification: "PI Damages" },
        { title: "Retain vocational expert if permanent work restrictions", orderIndex: 4, requiredCertification: "PI Litigation" },
        { title: "Retain life care planner for catastrophic injury cases", orderIndex: 5, requiredCertification: "PI Damages" },
        { title: "Calculate present value of future damages", orderIndex: 6, requiredCertification: "PI Damages" },
        { title: "Prepare comprehensive damages summary spreadsheet", orderIndex: 7, requiredCertification: "PI Damages" },
      ],
    },
    {
      name: "Demand Package Preparation & Submission",
      phase: "Pre-Litigation",
      orderIndex: 9,
      activationType: "auto",
      steps: [
        { title: "Draft demand letter with liability summary", orderIndex: 1, requiredCertification: "PI Demand" },
        { title: "Attach organized medical records, bills, lost wage docs", orderIndex: 2, requiredCertification: "PI Demand" },
        { title: "Include narrative of client impact", orderIndex: 3, requiredCertification: "PI Demand" },
        { title: "State specific demand amount with supporting rationale", orderIndex: 4, requiredCertification: "PI Demand" },
        { title: "Send via certified mail and email; obtain delivery confirmation", orderIndex: 5, requiredCertification: "PI Demand" },
        { title: "Set follow-up calendar: 30-day response window", orderIndex: 6, requiredCertification: "PI Demand" },
        { title: "Log submission details; track response timeline", orderIndex: 7, requiredCertification: "PI Demand" },
      ],
    },
    {
      name: "Settlement Negotiation & Authority Management",
      phase: "Pre-Litigation",
      orderIndex: 10,
      activationType: "auto",
      steps: [
        { title: "Review insurer's initial response with attorney", orderIndex: 1, requiredCertification: "PI Demand" },
        { title: "Prepare settlement authority memo for client", orderIndex: 2, requiredCertification: "PI Demand" },
        { title: "Obtain client's written authority range", orderIndex: 3, requiredCertification: "PI Demand" },
        { title: "Counter with written response", orderIndex: 4, requiredCertification: "PI Demand" },
        { title: "Explore mediation if near impasse", orderIndex: 5, requiredCertification: "PI Demand" },
        { title: "Evaluate bad faith exposure", orderIndex: 6, requiredCertification: "PI Litigation" },
        { title: "If settled: confirm authority, execute releases", orderIndex: 7, requiredCertification: "PI Demand" },
      ],
    },
    {
      name: "Filing Complaint & Service of Process",
      phase: "Litigation",
      orderIndex: 11,
      activationType: "manual",
      activationCondition: "Activated only when settlement negotiations have failed or SOL requires filing",
      steps: [
        { title: "Draft complaint with negligence counts", orderIndex: 1, requiredCertification: "PI Litigation" },
        { title: "File complaint in appropriate court", orderIndex: 2, requiredCertification: "PI Litigation" },
        { title: "Pay filing fees; obtain summons", orderIndex: 3, requiredCertification: "PI Litigation" },
        { title: "Serve defendants via process server", orderIndex: 4, requiredCertification: "PI Litigation" },
        { title: "Confirm service; calendar answer deadline", orderIndex: 5, requiredCertification: "PI Litigation" },
        { title: "File proof of service with court", orderIndex: 6, requiredCertification: "PI Litigation" },
        { title: "Open litigation section; notify client", orderIndex: 7, requiredCertification: "PI Litigation" },
      ],
    },
    {
      name: "Discovery Planning & Execution",
      phase: "Litigation — Discovery",
      orderIndex: 12,
      activationType: "auto",
      steps: [
        { title: "Prepare discovery plan", orderIndex: 1, requiredCertification: "PI Litigation" },
        { title: "Serve initial written discovery", orderIndex: 2, requiredCertification: "PI Litigation" },
        { title: "Review defendant's discovery responses", orderIndex: 3, requiredCertification: "PI Litigation" },
        { title: "File motions to compel if necessary", orderIndex: 4, requiredCertification: "PI Litigation" },
        { title: "Schedule depositions", orderIndex: 5, requiredCertification: "PI Litigation" },
        { title: "Respond to defendant's written discovery", orderIndex: 6, requiredCertification: "PI Litigation" },
        { title: "Organise all discovery into indexed folder structure", orderIndex: 7, requiredCertification: "PI Litigation" },
      ],
    },
    {
      name: "Expert Witness Retention & Disclosure",
      phase: "Litigation — Discovery",
      orderIndex: 13,
      activationType: "auto",
      steps: [
        { title: "Identify required experts", orderIndex: 1, requiredCertification: "PI Litigation" },
        { title: "Retain and execute engagement letters", orderIndex: 2, requiredCertification: "PI Litigation" },
        { title: "Provide experts with case materials", orderIndex: 3, requiredCertification: "PI Litigation" },
        { title: "Receive and review expert draft reports", orderIndex: 4, requiredCertification: "PI Litigation" },
        { title: "Finalize expert reports; disclose", orderIndex: 5, requiredCertification: "PI Litigation" },
        { title: "Prepare experts for Daubert challenges", orderIndex: 6, requiredCertification: "PI Litigation" },
        { title: "Calendar expert deposition dates", orderIndex: 7, requiredCertification: "PI Litigation" },
      ],
    },
    {
      name: "Deposition Preparation & Defence",
      phase: "Litigation — Discovery",
      orderIndex: 14,
      activationType: "auto",
      steps: [
        { title: "Review all case documents with client", orderIndex: 1, requiredCertification: "PI Litigation" },
        { title: "Conduct mock deposition session", orderIndex: 2, requiredCertification: "PI Litigation" },
        { title: "Review medical records and prior statements", orderIndex: 3, requiredCertification: "PI Litigation" },
        { title: "Advise client on deposition conduct", orderIndex: 4, requiredCertification: "PI Litigation" },
        { title: "Attend deposition; lodge objections", orderIndex: 5, requiredCertification: "PI Litigation" },
        { title: "Order certified transcript", orderIndex: 6, requiredCertification: "PI Litigation" },
        { title: "Update case file with deposition summary", orderIndex: 7, requiredCertification: "PI Litigation" },
      ],
    },
    {
      name: "Summary Judgment Defence",
      phase: "Litigation — Pre-Trial",
      orderIndex: 15,
      activationType: "auto",
      steps: [
        { title: "Calendar response deadline", orderIndex: 1, requiredCertification: "PI Litigation" },
        { title: "Analyse motion and supporting affidavits", orderIndex: 2, requiredCertification: "PI Litigation" },
        { title: "Gather controverting evidence", orderIndex: 3, requiredCertification: "PI Litigation" },
        { title: "Draft memorandum in opposition", orderIndex: 4, requiredCertification: "PI Litigation" },
        { title: "File response with supporting exhibits", orderIndex: 5, requiredCertification: "PI Litigation" },
        { title: "Prepare for and attend summary judgment hearing", orderIndex: 6, requiredCertification: "PI Litigation" },
        { title: "If denied: continue to trial prep. If granted: evaluate appeal", orderIndex: 7, requiredCertification: "PI Litigation" },
      ],
    },
    {
      name: "Mediation Preparation & Attendance",
      phase: "Pre-Trial",
      orderIndex: 16,
      activationType: "auto",
      steps: [
        { title: "Select qualified mediator", orderIndex: 1, requiredCertification: "PI Demand" },
        { title: "Prepare mediation summary", orderIndex: 2, requiredCertification: "PI Demand" },
        { title: "Prepare mediation exhibits package", orderIndex: 3, requiredCertification: "PI Demand" },
        { title: "Conduct pre-mediation conference with client", orderIndex: 4, requiredCertification: "PI Demand" },
        { title: "Attend mediation", orderIndex: 5, requiredCertification: "PI Demand" },
        { title: "Evaluate mediator's proposal with client", orderIndex: 6, requiredCertification: "PI Demand" },
        { title: "If settled: confirm terms in writing", orderIndex: 7, requiredCertification: "PI Demand" },
      ],
    },
    {
      name: "Trial Preparation",
      phase: "Trial",
      orderIndex: 17,
      activationType: "auto",
      steps: [
        { title: "Prepare trial notebook", orderIndex: 1, requiredCertification: "PI Litigation" },
        { title: "Draft opening statement and closing argument outlines", orderIndex: 2, requiredCertification: "PI Litigation" },
        { title: "Prepare direct and cross-examination outlines", orderIndex: 3, requiredCertification: "PI Litigation" },
        { title: "File motions in limine", orderIndex: 4, requiredCertification: "PI Litigation" },
        { title: "Prepare and exchange exhibit list", orderIndex: 5, requiredCertification: "PI Litigation" },
        { title: "Conduct mock trial or focus group", orderIndex: 6, requiredCertification: "PI Litigation" },
        { title: "Coordinate logistics: court reporter, exhibits, technology", orderIndex: 7, requiredCertification: "PI Litigation" },
      ],
    },
    {
      name: "Jury Selection (Voir Dire)",
      phase: "Trial",
      orderIndex: 18,
      activationType: "manual",
      activationCondition: "Activated only after trial date is set and case proceeds to trial",
      steps: [
        { title: "Review juror questionnaires", orderIndex: 1, requiredCertification: "PI Litigation" },
        { title: "Prepare voir dire questions", orderIndex: 2, requiredCertification: "PI Litigation" },
        { title: "Identify favourable and adverse jurors", orderIndex: 3, requiredCertification: "PI Litigation" },
        { title: "Exercise peremptory and for-cause challenges", orderIndex: 4, requiredCertification: "PI Litigation" },
        { title: "Document juror selection decisions", orderIndex: 5, requiredCertification: "PI Litigation" },
        { title: "Seat jury and alternates", orderIndex: 6, requiredCertification: "PI Litigation" },
        { title: "Begin trial with selected jury", orderIndex: 7, requiredCertification: "PI Litigation" },
      ],
    },
    {
      name: "Post-Verdict & Judgment Collection",
      phase: "Post-Trial",
      orderIndex: 19,
      activationType: "auto",
      steps: [
        { title: "Review verdict; assess post-trial motions", orderIndex: 1, requiredCertification: "PI Litigation" },
        { title: "File judgment if not entered automatically", orderIndex: 2, requiredCertification: "PI Litigation" },
        { title: "Evaluate defendant's assets for collection", orderIndex: 3, requiredCertification: "PI Litigation" },
        { title: "Serve writ of execution if needed", orderIndex: 4, requiredCertification: "PI Litigation" },
        { title: "Negotiate payment plan with defendant", orderIndex: 5, requiredCertification: "PI Litigation" },
        { title: "Evaluate appeal options if adverse verdict", orderIndex: 6, requiredCertification: "PI Litigation" },
        { title: "Document all collection actions and payments", orderIndex: 7, requiredCertification: "PI Litigation" },
      ],
    },
    {
      name: "Settlement Disbursement & File Closing",
      phase: "Resolution",
      orderIndex: 20,
      activationType: "conditional",
      activationCondition: "Activates when settlement is confirmed or judgment is paid",
      steps: [
        { title: "Deposit settlement funds into IOLTA", orderIndex: 1, requiredCertification: "PI Settlement" },
        { title: "Prepare settlement statement", orderIndex: 2, requiredCertification: "PI Settlement" },
        { title: "Negotiate medical liens", orderIndex: 3, requiredCertification: "PI Settlement" },
        { title: "Obtain lien satisfaction letters", orderIndex: 4, requiredCertification: "PI Settlement" },
        { title: "Present final settlement statement to client", orderIndex: 5, requiredCertification: "PI Settlement" },
        { title: "Disburse net client funds", orderIndex: 6, requiredCertification: "PI Settlement" },
        { title: "Send closing letter; archive file per retention policy", orderIndex: 7, requiredCertification: "PI Settlement" },
      ],
    },
  ],
};

export async function seedWorkflowTemplate() {
  console.log("Seeding workflow templates...");

  // Resolve Personal Injury practice area
  const [piArea] = await db
    .select()
    .from(practiceAreas)
    .where(ilike(practiceAreas.name, "Personal Injury%"))
    .limit(1);

  if (!piArea) {
    console.error('Personal Injury practice area not found. Run practice-area-taxonomy seed first.');
    return;
  }

  // Check if template already exists
  const [existing] = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.practiceAreaId, piArea.id))
    .limit(1);

  if (existing) {
    console.log(`Workflow template already exists for "${piArea.name}" — skipping.`);
    return;
  }

  // Create template
  const [template] = await db
    .insert(workflowTemplates)
    .values({
      practiceAreaId: piArea.id,
      name: PI_TEMPLATE.name,
    })
    .returning();

  console.log(`Created template: ${template.name} (${template.id})`);

  // Create modules and steps
  for (const mod of PI_TEMPLATE.modules) {
    const [module] = await db
      .insert(workflowModules)
      .values({
        templateId: template.id,
        name: mod.name,
        phase: mod.phase,
        orderIndex: mod.orderIndex,
        activationType: mod.activationType,
        activationCondition: mod.activationCondition ?? null,
      })
      .returning();

    console.log(`  Module: ${module.name}`);

    if (mod.steps.length > 0) {
      await db.insert(workflowTemplateSteps).values(
        mod.steps.map((s) => ({
          moduleId: module.id,
          title: s.title,
          description: s.description ?? null,
          orderIndex: s.orderIndex,
          dueInDays: s.dueInDays ?? null,
          requiredCertification: s.requiredCertification ?? null,
        })),
      );
    }

    console.log(`    ${mod.steps.length} steps`);
  }

  console.log("Workflow template seeded successfully!");
}
