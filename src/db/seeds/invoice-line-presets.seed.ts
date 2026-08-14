/**
 * The shipped catalog of invoice line presets.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THESE AMOUNTS ARE DEMO DATA.
 *
 * Government filing fees are published schedules that change — the USCIS fee
 * table moved substantially in 2024, and court fees differ by state and by
 * county. Nothing here should be treated as the current fee for any
 * jurisdiction. They exist so a new firm meets a working, plausibly-shaped
 * catalog instead of an empty list.
 *
 * A firm's real numbers arrive two ways: an administrator re-seeds corrected
 * figures through the CLI (which updates shipped rows in place), or staff save
 * their own from the invoice dialog, which creates firm-owned rows that shadow
 * nothing and simply sit alongside.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The account split is the substantive content here, not the amounts:
 *
 *   - `trust_iolta` — money the firm merely HOLDS. Advance fee deposits,
 *     government filing fees paid on the client's behalf, court costs, expert
 *     and investigator retainers, recording and service fees. Getting one of
 *     these into Operating is a trust-accounting violation, not a typo, which
 *     is most of why this catalog exists.
 *   - `operating` — the firm's own EARNED revenue. Consultations, flat
 *     attorney fees, drafting, hearing and trial appearances, review work.
 *
 * Scoping: most presets sit at practice-area level. A `caseType` is used only
 * where the charge genuinely is per-form — the per-petition USCIS fees — since
 * the taxonomy carries 687 case types and scoping everything that finely would
 * produce a catalog nobody could maintain.
 *
 * Names must match `PRACTICE_AREA_TAXONOMY` exactly; the seeder resolves them
 * through the same `codeFromParts()` the taxonomy was created with.
 */

export type LinePresetAccount = "operating" | "trust_iolta";

export type LinePresetSeed = {
  name: string;
  account: LinePresetAccount;
  defaultRate: number;
  /** Shown under the name in the picker to disambiguate. Never billed. */
  note?: string;
  /** Narrow to one case type. Both names must match the taxonomy exactly. */
  caseType?: { subcategory: string; name: string };
};

export type PracticeAreaLinePresets = {
  /** Must match a `PRACTICE_AREA_TAXONOMY` entry by name. */
  practiceArea: string;
  presets: readonly LinePresetSeed[];
};

/**
 * Shown on every invoice regardless of practice area — the charges any matter
 * can attract.
 */
export const GENERAL_LINE_PRESETS: readonly LinePresetSeed[] = [
  {
    name: "Advance fee deposit (retainer)",
    account: "trust_iolta",
    defaultRate: 2500,
    note: "Unearned on receipt — held in trust until billed against",
  },
  { name: "Initial consultation", account: "operating", defaultRate: 250 },
  { name: "Follow-up consultation", account: "operating", defaultRate: 150 },
  { name: "Document preparation", account: "operating", defaultRate: 175 },
  {
    name: "Photocopying and printing",
    account: "operating",
    defaultRate: 0.25,
    note: "Per page — set the quantity on the line",
  },
  { name: "Postage and certified mail", account: "operating", defaultRate: 12 },
  { name: "Notary fee", account: "operating", defaultRate: 15 },
  {
    name: "Courier and process server fee",
    account: "trust_iolta",
    defaultRate: 95,
    note: "Advanced on the client's behalf",
  },
  {
    name: "Records retrieval fee",
    account: "trust_iolta",
    defaultRate: 45,
  },
  {
    name: "Certified translation",
    account: "trust_iolta",
    defaultRate: 25,
    note: "Per page — set the quantity on the line",
  },
];

export const PRACTICE_AREA_LINE_PRESETS: readonly PracticeAreaLinePresets[] = [
  {
    practiceArea: "Family Law",
    presets: [
      {
        name: "Court filing fee — petition for dissolution",
        account: "trust_iolta",
        defaultRate: 409,
      },
      {
        name: "Court filing fee — response to petition",
        account: "trust_iolta",
        defaultRate: 297,
      },
      {
        name: "Court filing fee — petition for name change",
        account: "trust_iolta",
        defaultRate: 402,
      },
      {
        name: "Service of process",
        account: "trust_iolta",
        defaultRate: 95,
      },
      {
        name: "Parenting course fee",
        account: "trust_iolta",
        defaultRate: 65,
      },
      {
        name: "Guardian ad litem retainer",
        account: "trust_iolta",
        defaultRate: 1500,
      },
      {
        name: "Custody evaluation",
        account: "trust_iolta",
        defaultRate: 3500,
      },
      {
        name: "Attorney fee — contested divorce retainer",
        account: "trust_iolta",
        defaultRate: 5000,
        note: "Unearned on receipt — bill against it as work is done",
      },
      {
        name: "Attorney fee — uncontested divorce (flat)",
        account: "operating",
        defaultRate: 2500,
      },
      {
        name: "Attorney fee — prenuptial agreement (flat)",
        account: "operating",
        defaultRate: 1800,
      },
      {
        name: "QDRO preparation",
        account: "operating",
        defaultRate: 750,
      },
      {
        name: "Mediation session",
        account: "operating",
        defaultRate: 300,
        note: "Per hour — set the quantity on the line",
      },
      {
        name: "Hearing appearance",
        account: "operating",
        defaultRate: 850,
      },
    ],
  },
  {
    practiceArea: "Criminal Law",
    presets: [
      {
        name: "Attorney fee — felony defense retainer",
        account: "trust_iolta",
        defaultRate: 7500,
        note: "Unearned on receipt — bill against it as work is done",
      },
      {
        name: "Expert witness retainer",
        account: "trust_iolta",
        defaultRate: 2500,
      },
      {
        name: "Private investigator",
        account: "trust_iolta",
        defaultRate: 85,
        note: "Per hour — set the quantity on the line",
      },
      {
        name: "Transcript preparation fee",
        account: "trust_iolta",
        defaultRate: 350,
      },
      {
        name: "Appeal filing fee",
        account: "trust_iolta",
        defaultRate: 300,
      },
      {
        name: "Attorney fee — misdemeanor defense (flat)",
        account: "operating",
        defaultRate: 2500,
      },
      {
        name: "Attorney fee — record expungement (flat)",
        account: "operating",
        defaultRate: 1500,
      },
      {
        name: "Court appearance — arraignment",
        account: "operating",
        defaultRate: 500,
      },
      {
        name: "Trial day rate",
        account: "operating",
        defaultRate: 2500,
        note: "Per day — set the quantity on the line",
      },
      {
        name: "Administrative licence hearing",
        account: "operating",
        defaultRate: 750,
      },
    ],
  },
  {
    practiceArea: "Personal Injury Law",
    presets: [
      {
        name: "Case costs advance",
        account: "trust_iolta",
        defaultRate: 2500,
        note: "Client funds advanced against litigation costs",
      },
      {
        name: "Court filing fee — civil complaint",
        account: "trust_iolta",
        defaultRate: 405,
      },
      {
        name: "Medical records retrieval",
        account: "trust_iolta",
        defaultRate: 75,
      },
      {
        name: "Expert medical review",
        account: "trust_iolta",
        defaultRate: 1500,
      },
      {
        name: "Accident reconstruction expert",
        account: "trust_iolta",
        defaultRate: 3500,
      },
      {
        name: "Independent medical examination",
        account: "trust_iolta",
        defaultRate: 1200,
      },
      {
        name: "Deposition transcript",
        account: "trust_iolta",
        defaultRate: 650,
      },
      {
        name: "Mediation fee",
        account: "trust_iolta",
        defaultRate: 750,
        note: "Neutral's fee, per party",
      },
      {
        name: "Demand package preparation",
        account: "operating",
        defaultRate: 950,
      },
      {
        name: "Settlement conference appearance",
        account: "operating",
        defaultRate: 1200,
      },
    ],
  },
  {
    practiceArea: "Immigration Law",
    presets: [
      // ── Per-form filing fees, scoped to the case type they belong to ────────
      // The one place in this catalog where case-type scoping earns its keep: a
      // petition IS a form, and the fee is a property of that form.
      {
        name: "USCIS filing fee — I-130",
        account: "trust_iolta",
        defaultRate: 675,
        caseType: {
          subcategory: "Family-Based Immigration",
          name: "I-130 — Petition for Alien Relative",
        },
      },
      {
        name: "USCIS filing fee — I-485",
        account: "trust_iolta",
        defaultRate: 1440,
        caseType: {
          subcategory: "Family-Based Immigration",
          name: "I-485 — Adjustment of Status (Family-Based)",
        },
      },
      {
        name: "USCIS filing fee — I-765",
        account: "trust_iolta",
        defaultRate: 520,
        caseType: {
          subcategory: "Family-Based Immigration",
          name: "I-765 — Employment Authorization (Pending AOS)",
        },
      },
      {
        name: "USCIS filing fee — I-751",
        account: "trust_iolta",
        defaultRate: 750,
        caseType: {
          subcategory: "Family-Based Immigration",
          name: "Conditional Residence — I-751 Removal of Conditions",
        },
      },
      {
        name: "USCIS filing fee — I-601A",
        account: "trust_iolta",
        defaultRate: 795,
        caseType: {
          subcategory: "Family-Based Immigration",
          name: "I-601A — Provisional Unlawful Presence Waiver",
        },
      },
      {
        name: "USCIS filing fee — N-400",
        account: "trust_iolta",
        defaultRate: 760,
        caseType: {
          subcategory: "Citizenship & Naturalization",
          name: "N-400 — Application for Naturalization",
        },
      },
      {
        name: "USCIS filing fee — I-821D",
        account: "trust_iolta",
        defaultRate: 555,
        caseType: {
          subcategory: "Humanitarian Relief",
          name: "DACA — I-821D Initial Application",
        },
      },
      {
        name: "USCIS filing fee — I-129 (H-1B)",
        account: "trust_iolta",
        defaultRate: 780,
        note: "Base petition fee only — ACWIA and fraud fees are separate",
        caseType: {
          subcategory: "Non-Immigrant Visas",
          name: "H-1B — Specialty Occupation (I-129)",
        },
      },

      // ── Practice-area level ─────────────────────────────────────────────────
      {
        name: "USCIS biometrics fee",
        account: "trust_iolta",
        defaultRate: 85,
      },
      {
        name: "Attorney fee — removal defense retainer",
        account: "trust_iolta",
        defaultRate: 6000,
        note: "Unearned on receipt — bill against it as work is done",
      },
      {
        name: "Attorney fee — adjustment of status package (flat)",
        account: "operating",
        defaultRate: 3500,
      },
      {
        name: "Attorney fee — naturalization (flat)",
        account: "operating",
        defaultRate: 1500,
      },
      {
        name: "RFE or NOID response preparation",
        account: "operating",
        defaultRate: 850,
      },
      {
        name: "Immigration court appearance",
        account: "operating",
        defaultRate: 1200,
      },
      {
        name: "Consular interview preparation",
        account: "operating",
        defaultRate: 600,
      },
    ],
  },
  {
    practiceArea: "Business & Corporate Law",
    presets: [
      {
        name: "State filing fee — articles of incorporation",
        account: "trust_iolta",
        defaultRate: 125,
      },
      {
        name: "State filing fee — LLC formation",
        account: "trust_iolta",
        defaultRate: 100,
      },
      {
        name: "State filing fee — annual report",
        account: "trust_iolta",
        defaultRate: 150,
      },
      {
        name: "Registered agent fee (annual)",
        account: "trust_iolta",
        defaultRate: 175,
      },
      {
        name: "USPTO trademark application fee",
        account: "trust_iolta",
        defaultRate: 350,
        note: "Per class — set the quantity on the line",
      },
      {
        name: "Attorney fee — entity formation (flat)",
        account: "operating",
        defaultRate: 1500,
      },
      {
        name: "Operating agreement drafting",
        account: "operating",
        defaultRate: 1200,
      },
      {
        name: "Attorney fee — trademark application",
        account: "operating",
        defaultRate: 950,
      },
      {
        name: "Contract review",
        account: "operating",
        defaultRate: 375,
        note: "Per hour — set the quantity on the line",
      },
      {
        name: "Due diligence review",
        account: "operating",
        defaultRate: 2500,
      },
    ],
  },
  {
    practiceArea: "Estate Planning",
    presets: [
      {
        name: "Probate court filing fee",
        account: "trust_iolta",
        defaultRate: 465,
      },
      {
        name: "County recording fee",
        account: "trust_iolta",
        defaultRate: 85,
      },
      {
        name: "Publication of notice to creditors",
        account: "trust_iolta",
        defaultRate: 175,
      },
      {
        name: "Estate inventory and appraisal",
        account: "trust_iolta",
        defaultRate: 950,
      },
      {
        name: "Attorney fee — probate administration retainer",
        account: "trust_iolta",
        defaultRate: 4000,
        note: "Unearned on receipt — bill against it as work is done",
      },
      {
        name: "Attorney fee — simple will (flat)",
        account: "operating",
        defaultRate: 850,
      },
      {
        name: "Attorney fee — revocable living trust package",
        account: "operating",
        defaultRate: 3200,
      },
      {
        name: "Power of attorney and advance directive",
        account: "operating",
        defaultRate: 350,
      },
      {
        name: "Trust amendment or restatement",
        account: "operating",
        defaultRate: 750,
      },
      {
        name: "Deed preparation and transfer",
        account: "operating",
        defaultRate: 450,
      },
    ],
  },
  {
    practiceArea: "Employment Law",
    presets: [
      {
        name: "Attorney fee — discrimination claim retainer",
        account: "trust_iolta",
        defaultRate: 5000,
        note: "Unearned on receipt — bill against it as work is done",
      },
      {
        name: "Court filing fee — civil complaint",
        account: "trust_iolta",
        defaultRate: 405,
      },
      {
        name: "Deposition transcript",
        account: "trust_iolta",
        defaultRate: 650,
      },
      {
        name: "Expert economist retainer",
        account: "trust_iolta",
        defaultRate: 2500,
      },
      {
        name: "Mediation fee",
        account: "trust_iolta",
        defaultRate: 750,
        note: "Neutral's fee, per party",
      },
      {
        name: "EEOC charge preparation",
        account: "operating",
        defaultRate: 1200,
      },
      {
        name: "Severance agreement review",
        account: "operating",
        defaultRate: 750,
      },
      {
        name: "Non-compete agreement drafting",
        account: "operating",
        defaultRate: 850,
      },
      {
        name: "Employee handbook drafting",
        account: "operating",
        defaultRate: 2200,
      },
      {
        name: "Wage and hour audit",
        account: "operating",
        defaultRate: 3500,
      },
    ],
  },
  {
    practiceArea: "Real Estate Law",
    presets: [
      {
        name: "Escrow deposit",
        account: "trust_iolta",
        defaultRate: 5000,
        note: "Client funds held pending closing",
      },
      {
        name: "Title search fee",
        account: "trust_iolta",
        defaultRate: 175,
      },
      {
        name: "Lien and judgment search",
        account: "trust_iolta",
        defaultRate: 125,
      },
      {
        name: "County recording fee",
        account: "trust_iolta",
        defaultRate: 85,
      },
      {
        name: "Survey fee",
        account: "trust_iolta",
        defaultRate: 550,
      },
      {
        name: "Eviction filing fee",
        account: "trust_iolta",
        defaultRate: 185,
      },
      {
        name: "Zoning variance application fee",
        account: "trust_iolta",
        defaultRate: 750,
      },
      {
        name: "Attorney fee — residential closing (flat)",
        account: "operating",
        defaultRate: 950,
      },
      {
        name: "Attorney fee — commercial closing",
        account: "operating",
        defaultRate: 3500,
      },
      {
        name: "Deed preparation",
        account: "operating",
        defaultRate: 450,
      },
      {
        name: "Lease drafting and review",
        account: "operating",
        defaultRate: 850,
      },
    ],
  },
];
