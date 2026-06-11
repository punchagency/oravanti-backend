export type TaxonomyJurisdiction = "federal" | "state" | "federal & state" | "varies";

export type TaxonomyCaseType = {
  name: string;
  jurisdiction: TaxonomyJurisdiction;
};

export type TaxonomySubcategory = {
  name: string;
  caseTypes: readonly TaxonomyCaseType[];
};

export type TaxonomyPracticeArea = {
  name: string;
  subcategories: readonly TaxonomySubcategory[];
};

export const PRACTICE_AREA_TAXONOMY = [
  {
    "name": "Family Law",
    "subcategories": [
      {
        "name": "Divorce & Dissolution of Marriage",
        "caseTypes": [
          {
            "name": "Contested Divorce Proceedings",
            "jurisdiction": "state"
          },
          {
            "name": "Uncontested / Simplified Dissolution",
            "jurisdiction": "state"
          },
          {
            "name": "Collaborative Divorce",
            "jurisdiction": "state"
          },
          {
            "name": "Mediation & Settlement Negotiation",
            "jurisdiction": "state"
          },
          {
            "name": "Legal Separation Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "High-Asset Divorce & Complex Property Division",
            "jurisdiction": "state"
          },
          {
            "name": "Equitable Distribution of Marital Assets",
            "jurisdiction": "state"
          },
          {
            "name": "Hidden Asset Investigation / Forensic Accounting Coordination",
            "jurisdiction": "state"
          },
          {
            "name": "Retirement Account Division (QDRO)",
            "jurisdiction": "federal & state"
          }
        ]
      },
      {
        "name": "Child Custody & Parenting",
        "caseTypes": [
          {
            "name": "Parental Responsibility (Legal & Physical Custody)",
            "jurisdiction": "state"
          },
          {
            "name": "Parenting Plan Drafting",
            "jurisdiction": "state"
          },
          {
            "name": "Parenting Plan Modification",
            "jurisdiction": "state"
          },
          {
            "name": "Time-Sharing Schedule",
            "jurisdiction": "state"
          },
          {
            "name": "Relocation Petitions (FL §61.13001)",
            "jurisdiction": "state"
          },
          {
            "name": "Emergency Temporary Custody",
            "jurisdiction": "state"
          },
          {
            "name": "Guardian ad Litem Proceedings",
            "jurisdiction": "state"
          },
          {
            "name": "Reunification Cases",
            "jurisdiction": "state"
          },
          {
            "name": "International Child Custody / Hague Convention",
            "jurisdiction": "federal & state"
          }
        ]
      },
      {
        "name": "Child Support",
        "caseTypes": [
          {
            "name": "Child Support Calculation (FL Guidelines)",
            "jurisdiction": "state"
          },
          {
            "name": "Child Support Establishment",
            "jurisdiction": "state"
          },
          {
            "name": "Child Support Modification",
            "jurisdiction": "state"
          },
          {
            "name": "Child Support Enforcement / Contempt",
            "jurisdiction": "state"
          },
          {
            "name": "Retroactive Child Support",
            "jurisdiction": "state"
          },
          {
            "name": "Imputed Income Arguments",
            "jurisdiction": "state"
          },
          {
            "name": "UIFSA Interstate Support",
            "jurisdiction": "federal & state"
          }
        ]
      },
      {
        "name": "Alimony & Spousal Support",
        "caseTypes": [
          {
            "name": "Bridge-the-Gap Alimony",
            "jurisdiction": "state"
          },
          {
            "name": "Rehabilitative Alimony",
            "jurisdiction": "state"
          },
          {
            "name": "Durational Alimony",
            "jurisdiction": "state"
          },
          {
            "name": "Permanent Alimony",
            "jurisdiction": "state"
          },
          {
            "name": "Alimony Modification",
            "jurisdiction": "state"
          },
          {
            "name": "Alimony Termination (Cohabitation / Retirement)",
            "jurisdiction": "state"
          },
          {
            "name": "Contempt & Enforcement of Alimony Orders",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Domestic Violence & Protective Orders",
        "caseTypes": [
          {
            "name": "Injunction for Protection Against Domestic Violence",
            "jurisdiction": "state"
          },
          {
            "name": "Injunction for Protection Against Repeat Violence",
            "jurisdiction": "state"
          },
          {
            "name": "Injunction for Protection Against Stalking",
            "jurisdiction": "state"
          },
          {
            "name": "Dating Violence Injunction",
            "jurisdiction": "state"
          },
          {
            "name": "Sexual Violence Injunction",
            "jurisdiction": "state"
          },
          {
            "name": "Emergency Temporary Injunction",
            "jurisdiction": "state"
          },
          {
            "name": "Violation of Injunction Defense",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Pre- & Post-Marital Agreements",
        "caseTypes": [
          {
            "name": "Prenuptial Agreement Drafting & Review",
            "jurisdiction": "state"
          },
          {
            "name": "Postnuptial Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Cohabitation / Domestic Partnership Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Marital Settlement Agreement (MSA)",
            "jurisdiction": "state"
          },
          {
            "name": "MSA Enforcement & Modification",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Paternity & Parentage",
        "caseTypes": [
          {
            "name": "Paternity Establishment",
            "jurisdiction": "state"
          },
          {
            "name": "Disestablishment of Paternity",
            "jurisdiction": "state"
          },
          {
            "name": "Legitimation",
            "jurisdiction": "state"
          },
          {
            "name": "DNA Testing Coordination",
            "jurisdiction": "state"
          },
          {
            "name": "Parental Rights of Unmarried Father",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Adoption & Guardianship",
        "caseTypes": [
          {
            "name": "Domestic Infant Adoption",
            "jurisdiction": "state"
          },
          {
            "name": "Step-Parent Adoption",
            "jurisdiction": "state"
          },
          {
            "name": "Second-Parent / Relative Adoption",
            "jurisdiction": "state"
          },
          {
            "name": "Adult Adoption",
            "jurisdiction": "state"
          },
          {
            "name": "International Adoption Coordination",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Termination of Parental Rights (TPR)",
            "jurisdiction": "state"
          },
          {
            "name": "Guardianship of Minor (FL Ch. 744)",
            "jurisdiction": "state"
          },
          {
            "name": "Guardianship of Incapacitated Adult",
            "jurisdiction": "state"
          },
          {
            "name": "Emergency Temporary Guardianship",
            "jurisdiction": "state"
          },
          {
            "name": "Dependency / DCF Proceedings",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Name Change",
        "caseTypes": [
          {
            "name": "Adult Legal Name Change",
            "jurisdiction": "state"
          },
          {
            "name": "Minor Name Change",
            "jurisdiction": "state"
          },
          {
            "name": "Gender Marker Change",
            "jurisdiction": "state"
          }
        ]
      }
    ]
  },
  {
    "name": "Criminal Law",
    "subcategories": [
      {
        "name": "Misdemeanor Defense",
        "caseTypes": [
          {
            "name": "DUI / DWI — First Offense",
            "jurisdiction": "state"
          },
          {
            "name": "DUI — Prior Offenses / Felony DUI",
            "jurisdiction": "state"
          },
          {
            "name": "Simple Battery & Assault",
            "jurisdiction": "state"
          },
          {
            "name": "Domestic Battery (Misdemeanor)",
            "jurisdiction": "state"
          },
          {
            "name": "Petty Theft / Retail Theft / Shoplifting",
            "jurisdiction": "state"
          },
          {
            "name": "Trespassing",
            "jurisdiction": "state"
          },
          {
            "name": "Disorderly Conduct / Breach of Peace",
            "jurisdiction": "state"
          },
          {
            "name": "Drug Possession — Small Quantity / Personal Use",
            "jurisdiction": "state"
          },
          {
            "name": "Driving with Suspended License (DWLS)",
            "jurisdiction": "state"
          },
          {
            "name": "Diversion & Pre-Trial Intervention (PTI)",
            "jurisdiction": "state"
          },
          {
            "name": "Criminal Mischief / Vandalism",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Felony Defense",
        "caseTypes": [
          {
            "name": "Aggravated Assault / Battery with Deadly Weapon",
            "jurisdiction": "state"
          },
          {
            "name": "Domestic Violence — Felony Battery / Strangulation",
            "jurisdiction": "state"
          },
          {
            "name": "Grand Theft (2nd / 3rd Degree)",
            "jurisdiction": "state"
          },
          {
            "name": "Burglary (Occupied / Unoccupied Dwelling)",
            "jurisdiction": "state"
          },
          {
            "name": "Robbery / Armed Robbery / Carjacking",
            "jurisdiction": "state"
          },
          {
            "name": "Drug Trafficking & Distribution",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Drug Possession with Intent to Sell",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Weapons Charges / Illegal Firearm Possession",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Felon in Possession of Firearm",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Sexual Battery / Rape",
            "jurisdiction": "state"
          },
          {
            "name": "Lewd & Lascivious Conduct",
            "jurisdiction": "state"
          },
          {
            "name": "Homicide / Manslaughter / Murder (1st / 2nd Degree)",
            "jurisdiction": "state"
          },
          {
            "name": "Kidnapping / False Imprisonment",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Home Invasion Robbery",
            "jurisdiction": "state"
          },
          {
            "name": "Arson",
            "jurisdiction": "federal & state"
          }
        ]
      },
      {
        "name": "White-Collar Crime",
        "caseTypes": [
          {
            "name": "Wire Fraud / Mail Fraud",
            "jurisdiction": "federal"
          },
          {
            "name": "Insurance Fraud",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Mortgage Fraud",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Healthcare Fraud",
            "jurisdiction": "federal"
          },
          {
            "name": "Embezzlement",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Money Laundering",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Securities & Investment Fraud",
            "jurisdiction": "federal"
          },
          {
            "name": "Identity Theft / Fraud",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Forgery & Counterfeiting",
            "jurisdiction": "federal & state"
          },
          {
            "name": "RICO Violations",
            "jurisdiction": "federal"
          },
          {
            "name": "Tax Evasion / Federal Tax Crimes",
            "jurisdiction": "federal"
          },
          {
            "name": "Public Corruption / Bribery",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Computer Fraud (CFAA Violations)",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Drug & Controlled Substance Offenses",
        "caseTypes": [
          {
            "name": "Possession — Schedule I–V",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Possession with Intent to Distribute",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Drug Trafficking (Mandatory Minimums)",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Conspiracy to Distribute",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Drug Court & Treatment Diversion",
            "jurisdiction": "state"
          },
          {
            "name": "Federal Drug Charges",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Sex Offenses & Registration",
        "caseTypes": [
          {
            "name": "Sexual Battery Defense",
            "jurisdiction": "state"
          },
          {
            "name": "Lewd or Lascivious Molestation",
            "jurisdiction": "state"
          },
          {
            "name": "Solicitation / Prostitution",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Internet / Online Solicitation of Minor",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Child Pornography Charges",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Sex Offender Registration Compliance",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Removal from Sex Offender Registry",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Post-Conviction Relief & Appeals",
        "caseTypes": [
          {
            "name": "Direct Appeal to DCA / Florida Supreme Court",
            "jurisdiction": "state"
          },
          {
            "name": "Rule 3.850 Motion (Post-Conviction Relief)",
            "jurisdiction": "state"
          },
          {
            "name": "Rule 3.800 Motion (Illegal Sentence Correction)",
            "jurisdiction": "state"
          },
          {
            "name": "Habeas Corpus Petition (State & Federal)",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Sentence Reduction / Modification",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Violation of Probation / Community Control Defense",
            "jurisdiction": "state"
          },
          {
            "name": "Expungement of Record (FL §943.0585)",
            "jurisdiction": "state"
          },
          {
            "name": "Record Sealing (FL §943.059)",
            "jurisdiction": "state"
          },
          {
            "name": "Clemency / Pardon / Restoration of Civil Rights",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Stand Your Ground / Immunity Hearing",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Juvenile Defense",
        "caseTypes": [
          {
            "name": "Juvenile Delinquency Proceedings",
            "jurisdiction": "state"
          },
          {
            "name": "Waiver to Adult Court — Opposition",
            "jurisdiction": "state"
          },
          {
            "name": "Diversion & Restorative Justice Programs",
            "jurisdiction": "state"
          },
          {
            "name": "Juvenile Probation Violation",
            "jurisdiction": "state"
          },
          {
            "name": "Sealing of Juvenile Records",
            "jurisdiction": "state"
          }
        ]
      }
    ]
  },
  {
    "name": "Personal Injury Law",
    "subcategories": [
      {
        "name": "Motor Vehicle Accidents",
        "caseTypes": [
          {
            "name": "Auto / Car Accident — Liability Claim",
            "jurisdiction": "state"
          },
          {
            "name": "Truck / Semi-Truck / Commercial Vehicle Collision",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Motorcycle Accident",
            "jurisdiction": "state"
          },
          {
            "name": "Bicycle Accident",
            "jurisdiction": "state"
          },
          {
            "name": "Pedestrian Struck by Vehicle",
            "jurisdiction": "state"
          },
          {
            "name": "Rideshare Accident (Uber / Lyft)",
            "jurisdiction": "state"
          },
          {
            "name": "Bus Accident (Public & Private)",
            "jurisdiction": "state"
          },
          {
            "name": "Uninsured Motorist (UM) Claim",
            "jurisdiction": "state"
          },
          {
            "name": "Underinsured Motorist (UIM) Claim",
            "jurisdiction": "state"
          },
          {
            "name": "PIP (No-Fault) Insurance Claim",
            "jurisdiction": "state"
          },
          {
            "name": "Hit & Run Accident",
            "jurisdiction": "state"
          },
          {
            "name": "Rear-End / Chain Reaction Collision",
            "jurisdiction": "state"
          },
          {
            "name": "Distracted / Drowsy / Impaired Driver Claim",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Premises Liability",
        "caseTypes": [
          {
            "name": "Slip & Fall",
            "jurisdiction": "state"
          },
          {
            "name": "Trip & Fall",
            "jurisdiction": "state"
          },
          {
            "name": "Negligent Security (Assault on Property)",
            "jurisdiction": "state"
          },
          {
            "name": "Swimming Pool / Drowning Accident",
            "jurisdiction": "state"
          },
          {
            "name": "Dog Bite & Animal Attack (FL §767.04)",
            "jurisdiction": "state"
          },
          {
            "name": "Elevator & Escalator Accident",
            "jurisdiction": "state"
          },
          {
            "name": "Amusement / Theme Park Injury",
            "jurisdiction": "state"
          },
          {
            "name": "Retail Store / Grocery Store Injury",
            "jurisdiction": "state"
          },
          {
            "name": "Parking Lot Accident",
            "jurisdiction": "state"
          },
          {
            "name": "Florida Dram Shop / Alcohol Liability",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Construction & Workplace Injury",
        "caseTypes": [
          {
            "name": "Construction Site Accident",
            "jurisdiction": "state"
          },
          {
            "name": "Scaffold / Ladder / Fall from Height",
            "jurisdiction": "state"
          },
          {
            "name": "Electrocution on Job Site",
            "jurisdiction": "state"
          },
          {
            "name": "Struck-By / Caught-In/Between Accident",
            "jurisdiction": "state"
          },
          {
            "name": "OSHA Violation Claims",
            "jurisdiction": "federal"
          },
          {
            "name": "Third-Party Liability (Non-Employer)",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Medical Malpractice",
        "caseTypes": [
          {
            "name": "Surgical Errors",
            "jurisdiction": "state"
          },
          {
            "name": "Misdiagnosis / Failure to Diagnose",
            "jurisdiction": "state"
          },
          {
            "name": "Delayed Diagnosis — Cancer / Stroke / Heart Attack",
            "jurisdiction": "state"
          },
          {
            "name": "Medication & Prescription Errors",
            "jurisdiction": "state"
          },
          {
            "name": "Birth Injuries (Hypoxia, Cerebral Palsy, Erb's Palsy)",
            "jurisdiction": "state"
          },
          {
            "name": "Anesthesia Errors",
            "jurisdiction": "state"
          },
          {
            "name": "Hospital-Acquired Infections / Negligence",
            "jurisdiction": "state"
          },
          {
            "name": "Nursing Home Abuse & Neglect",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Wrongful Birth / Wrongful Life",
            "jurisdiction": "state"
          },
          {
            "name": "Pre-Suit Investigation (FL §766.106)",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Product Liability",
        "caseTypes": [
          {
            "name": "Defective Product Design",
            "jurisdiction": "state"
          },
          {
            "name": "Manufacturing Defect",
            "jurisdiction": "state"
          },
          {
            "name": "Failure to Warn / Inadequate Labeling",
            "jurisdiction": "state"
          },
          {
            "name": "Pharmaceutical / Drug Liability",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Defective Medical Device",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Automotive Defect (Airbag, Tire, Seatbelt)",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Children's Product Safety",
            "jurisdiction": "federal & state"
          }
        ]
      },
      {
        "name": "Wrongful Death",
        "caseTypes": [
          {
            "name": "Wrongful Death Claim — Surviving Spouse / Children",
            "jurisdiction": "state"
          },
          {
            "name": "Wrongful Death — Loss of Parental Companionship (Minor Children)",
            "jurisdiction": "state"
          },
          {
            "name": "Economic Damages — Lost Earnings & Net Accumulations",
            "jurisdiction": "state"
          },
          {
            "name": "Non-Economic Damages — Pain, Suffering, Mental Anguish",
            "jurisdiction": "state"
          },
          {
            "name": "Survival Action (Pre-Death Pain & Suffering)",
            "jurisdiction": "state"
          },
          {
            "name": "Wrongful Death — Auto / Trucking",
            "jurisdiction": "state"
          },
          {
            "name": "Wrongful Death — Medical Malpractice",
            "jurisdiction": "state"
          },
          {
            "name": "Wrongful Death — Workplace / Construction",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Workers' Compensation",
        "caseTypes": [
          {
            "name": "On-the-Job Injury Claim Filing",
            "jurisdiction": "state"
          },
          {
            "name": "Occupational Disease",
            "jurisdiction": "state"
          },
          {
            "name": "Repetitive Motion / Cumulative Trauma",
            "jurisdiction": "state"
          },
          {
            "name": "Disputed Compensability / Coverage Denial",
            "jurisdiction": "state"
          },
          {
            "name": "Independent Medical Examination (IME) Challenge",
            "jurisdiction": "state"
          },
          {
            "name": "Maximum Medical Improvement (MMI) Disputes",
            "jurisdiction": "state"
          },
          {
            "name": "Permanent Impairment Rating Disputes",
            "jurisdiction": "state"
          },
          {
            "name": "Workers' Comp Settlement (Lump Sum)",
            "jurisdiction": "state"
          },
          {
            "name": "Third-Party Liability Coordination",
            "jurisdiction": "state"
          },
          {
            "name": "Employer Retaliation for Filing WC Claim",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Insurance Claims & Bad Faith",
        "caseTypes": [
          {
            "name": "First-Party Insurance Bad Faith",
            "jurisdiction": "state"
          },
          {
            "name": "Third-Party Insurance Bad Faith",
            "jurisdiction": "state"
          },
          {
            "name": "Homeowner's Insurance Claim Disputes",
            "jurisdiction": "state"
          },
          {
            "name": "Property Damage / Hurricane / Flood Claims",
            "jurisdiction": "state"
          },
          {
            "name": "Denial of Coverage Appeals",
            "jurisdiction": "state"
          },
          {
            "name": "Assignment of Benefits (AOB) Disputes",
            "jurisdiction": "state"
          }
        ]
      }
    ]
  },
  {
    "name": "Immigration Law",
    "subcategories": [
      {
        "name": "Family-Based Immigration",
        "caseTypes": [
          {
            "name": "I-130 — Petition for Alien Relative",
            "jurisdiction": "federal"
          },
          {
            "name": "I-130A — Supplemental Info for Spouse Beneficiary",
            "jurisdiction": "federal"
          },
          {
            "name": "I-485 — Adjustment of Status (Family-Based)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-485J — Supplement J (Portability)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-864 / I-864A — Affidavit of Support",
            "jurisdiction": "federal"
          },
          {
            "name": "I-864EZ — Simplified Affidavit of Support",
            "jurisdiction": "federal"
          },
          {
            "name": "I-765 — Employment Authorization (Pending AOS)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-131 — Advance Parole / Travel Document (Pending AOS)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-131A — Application for Travel Document (LPR)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-601 — Waiver of Inadmissibility",
            "jurisdiction": "federal"
          },
          {
            "name": "I-601A — Provisional Unlawful Presence Waiver",
            "jurisdiction": "federal"
          },
          {
            "name": "I-212 — Permission to Reapply After Removal",
            "jurisdiction": "federal"
          },
          {
            "name": "DS-260 — Immigrant Visa Application (Consular)",
            "jurisdiction": "federal"
          },
          {
            "name": "DS-261 — Immigrant Visa Agent Selection",
            "jurisdiction": "federal"
          },
          {
            "name": "I-824 — Action on Approved Petition",
            "jurisdiction": "federal"
          },
          {
            "name": "NVC Processing — National Visa Center Coordination",
            "jurisdiction": "federal"
          },
          {
            "name": "Domestic Consular Processing",
            "jurisdiction": "federal"
          },
          {
            "name": "Consular Interview Preparation & Coaching",
            "jurisdiction": "federal"
          },
          {
            "name": "CSPA — Child Status Protection Act Analysis",
            "jurisdiction": "federal"
          },
          {
            "name": "Priority Date Monitoring & Tracking",
            "jurisdiction": "federal"
          },
          {
            "name": "Spouse of USC (IR-1 / CR-1)",
            "jurisdiction": "federal"
          },
          {
            "name": "Child of USC — Unmarried Under 21 (IR-2)",
            "jurisdiction": "federal"
          },
          {
            "name": "Adopted Child of USC (IR-3 / IR-4)",
            "jurisdiction": "federal"
          },
          {
            "name": "Parent of USC (IR-5)",
            "jurisdiction": "federal"
          },
          {
            "name": "Spouse/Child of LPR — F2A Preference",
            "jurisdiction": "federal"
          },
          {
            "name": "Unmarried Sons/Daughters of LPR — F2B Preference",
            "jurisdiction": "federal"
          },
          {
            "name": "Unmarried Sons/Daughters of USC — F1 Preference",
            "jurisdiction": "federal"
          },
          {
            "name": "Married Sons/Daughters of USC — F3 Preference",
            "jurisdiction": "federal"
          },
          {
            "name": "Siblings of USC — F4 Preference",
            "jurisdiction": "federal"
          },
          {
            "name": "RFE Response — Family-Based",
            "jurisdiction": "federal"
          },
          {
            "name": "NOID Response — Family-Based",
            "jurisdiction": "federal"
          },
          {
            "name": "Biometrics & Interview Scheduling Assistance",
            "jurisdiction": "federal"
          },
          {
            "name": "Conditional Residence — I-751 Removal of Conditions",
            "jurisdiction": "federal"
          },
          {
            "name": "I-751 Waiver (Divorce / Abuse / Hardship)",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Humanitarian Relief",
        "caseTypes": [
          {
            "name": "I-360 — VAWA Self-Petition (Spouse / Child / Parent of Abuser)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-485 — Adjustment of Status (VAWA-Based)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-765 — Employment Authorization (VAWA / U / T / Asylum)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-131 — Travel Document (Humanitarian Cases)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-918 — U Visa Petition (Crime Victim)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-918B — U Visa Law Enforcement Certification",
            "jurisdiction": "federal"
          },
          {
            "name": "I-918A — U Visa Family Derivative Petition",
            "jurisdiction": "federal"
          },
          {
            "name": "I-192 — Advance Permission to Enter (U / T Visa Grounds)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-914 — T Visa Petition (Trafficking Victim)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-914B — T Visa Law Enforcement Declaration",
            "jurisdiction": "federal"
          },
          {
            "name": "I-914A — T Visa Family Derivative Petition",
            "jurisdiction": "federal"
          },
          {
            "name": "I-589 — Asylum Application (Affirmative)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-589 — Defensive Asylum (In Removal Proceedings)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-730 — Refugee / Asylee Relative Petition",
            "jurisdiction": "federal"
          },
          {
            "name": "I-485 — Adjustment of Status (Asylum-Based, 1-Year)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-602 — Refugee / Asylee Adjustment Waiver",
            "jurisdiction": "federal"
          },
          {
            "name": "I-539 — Extension / Change of Status (Pending Humanitarian)",
            "jurisdiction": "federal"
          },
          {
            "name": "Special Immigrant Juvenile Status (SIJS) — I-360",
            "jurisdiction": "federal & state"
          },
          {
            "name": "SIJS — State Court Order Coordination",
            "jurisdiction": "state"
          },
          {
            "name": "SIJS — I-485 Adjustment of Status",
            "jurisdiction": "federal"
          },
          {
            "name": "Temporary Protected Status (TPS) — I-821",
            "jurisdiction": "federal"
          },
          {
            "name": "TPS Extension & Re-Registration",
            "jurisdiction": "federal"
          },
          {
            "name": "DACA — I-821D Initial Application",
            "jurisdiction": "federal"
          },
          {
            "name": "DACA — I-765 (c)(33) Employment Authorization",
            "jurisdiction": "federal"
          },
          {
            "name": "DACA Renewal",
            "jurisdiction": "federal"
          },
          {
            "name": "I-290B — Notice of Appeal / Motion (Humanitarian Denials)",
            "jurisdiction": "federal"
          },
          {
            "name": "RFE / NOID Response — Humanitarian Cases",
            "jurisdiction": "federal"
          },
          {
            "name": "Withholding of Removal — INA §241(b)(3)",
            "jurisdiction": "federal"
          },
          {
            "name": "Convention Against Torture (CAT) Relief",
            "jurisdiction": "federal"
          },
          {
            "name": "Cuban Adjustment Act",
            "jurisdiction": "federal"
          },
          {
            "name": "Nicaraguan & Central American Relief Act (NACARA)",
            "jurisdiction": "federal"
          },
          {
            "name": "Haitian Refugee Immigration Fairness Act (HRIFA)",
            "jurisdiction": "federal"
          },
          {
            "name": "Lautenberg Amendment (Religious Minorities)",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Employment-Based Immigration",
        "caseTypes": [
          {
            "name": "I-140 — Immigrant Petition for Alien Workers",
            "jurisdiction": "federal"
          },
          {
            "name": "EB-1A — Extraordinary Ability",
            "jurisdiction": "federal"
          },
          {
            "name": "EB-1B — Outstanding Professor or Researcher",
            "jurisdiction": "federal"
          },
          {
            "name": "EB-1C — Multinational Manager / Executive",
            "jurisdiction": "federal"
          },
          {
            "name": "EB-2 — Advanced Degree Professional",
            "jurisdiction": "federal"
          },
          {
            "name": "EB-2 NIW — National Interest Waiver (I-140 Self-Petition)",
            "jurisdiction": "federal"
          },
          {
            "name": "EB-3 — Skilled Worker / Professional / Unskilled",
            "jurisdiction": "federal"
          },
          {
            "name": "EB-4 — Special Immigrants (Religious, Broadcasters, etc.)",
            "jurisdiction": "federal"
          },
          {
            "name": "EB-5 — Investor Visa ($800K / $1.05M Thresholds)",
            "jurisdiction": "federal"
          },
          {
            "name": "PERM — Labor Certification (ETA 9089)",
            "jurisdiction": "federal"
          },
          {
            "name": "PERM Audit Response",
            "jurisdiction": "federal"
          },
          {
            "name": "I-485 — Adjustment of Status (Employment-Based)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-485J — Supplement J / AC21 Portability",
            "jurisdiction": "federal"
          },
          {
            "name": "I-765 — Employment Authorization (Pending Employment AOS)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-131 — Advance Parole (Pending Employment AOS)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-539 — Extension / Change of Status (Employment-Based)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-824 — Duplicate Approval Notice",
            "jurisdiction": "federal"
          },
          {
            "name": "I-601 / I-601A — Waiver of Inadmissibility (Employment-Based)",
            "jurisdiction": "federal"
          },
          {
            "name": "Priority Date Monitoring & Visa Bulletin Analysis",
            "jurisdiction": "federal"
          },
          {
            "name": "RFE / NOID Response — Employment-Based",
            "jurisdiction": "federal"
          },
          {
            "name": "I-9 — Employer Compliance Audit & Training",
            "jurisdiction": "federal"
          },
          {
            "name": "E-Verify Enrollment & Compliance",
            "jurisdiction": "federal"
          },
          {
            "name": "Naturalization (N-400) — Permanent Residents",
            "jurisdiction": "federal"
          },
          {
            "name": "N-600 — Certificate of Citizenship",
            "jurisdiction": "federal"
          },
          {
            "name": "N-565 — Replacement Citizenship Certificate",
            "jurisdiction": "federal"
          },
          {
            "name": "I-290B — Motion to Reopen / Reconsider (Employment Denials)",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Non-Immigrant Visas",
        "caseTypes": [
          {
            "name": "H-1B — Specialty Occupation (I-129)",
            "jurisdiction": "federal"
          },
          {
            "name": "H-1B Cap Registration / Lottery",
            "jurisdiction": "federal"
          },
          {
            "name": "H-1B Cap-Exempt Filing",
            "jurisdiction": "federal"
          },
          {
            "name": "H-1B Transfer / Amendment / Extension",
            "jurisdiction": "federal"
          },
          {
            "name": "H-2A — Temporary Agricultural Worker",
            "jurisdiction": "federal"
          },
          {
            "name": "H-2B — Temporary Non-Agricultural Worker",
            "jurisdiction": "federal"
          },
          {
            "name": "H-4 EAD — Spouse of H-1B (I-765 (c)(26))",
            "jurisdiction": "federal"
          },
          {
            "name": "L-1A — Intracompany Transferee (Manager / Executive)",
            "jurisdiction": "federal"
          },
          {
            "name": "L-1B — Intracompany Transferee (Specialized Knowledge)",
            "jurisdiction": "federal"
          },
          {
            "name": "L-2 Spouse — EAD Coordination",
            "jurisdiction": "federal"
          },
          {
            "name": "O-1A — Extraordinary Ability (Sciences / Business / Athletics)",
            "jurisdiction": "federal"
          },
          {
            "name": "O-1B — Extraordinary Achievement (Arts / Entertainment)",
            "jurisdiction": "federal"
          },
          {
            "name": "O-2 — Essential Support Personnel",
            "jurisdiction": "federal"
          },
          {
            "name": "P-1A — Internationally Recognized Athlete",
            "jurisdiction": "federal"
          },
          {
            "name": "P-1B — Internationally Recognized Entertainment Group",
            "jurisdiction": "federal"
          },
          {
            "name": "P-3 — Culturally Unique Program",
            "jurisdiction": "federal"
          },
          {
            "name": "TN — Trade NAFTA / USMCA (Canada & Mexico)",
            "jurisdiction": "federal"
          },
          {
            "name": "E-1 — Treaty Trader Visa",
            "jurisdiction": "federal"
          },
          {
            "name": "E-2 — Treaty Investor Visa",
            "jurisdiction": "federal"
          },
          {
            "name": "E-3 — Australian Specialty Occupation",
            "jurisdiction": "federal"
          },
          {
            "name": "R-1 — Religious Worker Visa",
            "jurisdiction": "federal"
          },
          {
            "name": "J-1 — Exchange Visitor Visa",
            "jurisdiction": "federal"
          },
          {
            "name": "J-1 Waiver — I-612 (Conrad 30 / Hardship / IGA / Persecution)",
            "jurisdiction": "federal"
          },
          {
            "name": "F-1 — Student Visa / Status Maintenance",
            "jurisdiction": "federal"
          },
          {
            "name": "F-1 OPT — Optional Practical Training (I-765)",
            "jurisdiction": "federal"
          },
          {
            "name": "F-1 STEM OPT Extension",
            "jurisdiction": "federal"
          },
          {
            "name": "F-1 CPT — Curricular Practical Training",
            "jurisdiction": "federal"
          },
          {
            "name": "M-1 — Vocational Student",
            "jurisdiction": "federal"
          },
          {
            "name": "B-1 / B-2 — Visitor for Business / Pleasure",
            "jurisdiction": "federal"
          },
          {
            "name": "B-1/B-2 Extension / Change of Status (I-539)",
            "jurisdiction": "federal"
          },
          {
            "name": "I-539 — Extension or Change of Nonimmigrant Status",
            "jurisdiction": "federal"
          },
          {
            "name": "I-539A — Biometric Supplement",
            "jurisdiction": "federal"
          },
          {
            "name": "DS-160 — Non-Immigrant Visa Application (Consular)",
            "jurisdiction": "federal"
          },
          {
            "name": "RFE / NOID Response — Non-Immigrant Cases",
            "jurisdiction": "federal"
          },
          {
            "name": "Consular Processing — Non-Immigrant Visa",
            "jurisdiction": "federal"
          },
          {
            "name": "Consular Interview Preparation",
            "jurisdiction": "federal"
          },
          {
            "name": "Prior Visa Denial / 214(b) Reapplication Strategy",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Removal Defense & Immigration Court Litigation",
        "caseTypes": [
          {
            "name": "EOIR-26 — Notice of Appeal to BIA",
            "jurisdiction": "federal"
          },
          {
            "name": "EOIR-27 — Notice of Entry of Appearance Before BIA",
            "jurisdiction": "federal"
          },
          {
            "name": "EOIR-29 — Appeal of Visa Petition Denial to BIA",
            "jurisdiction": "federal"
          },
          {
            "name": "EOIR-42A — Cancellation of Removal (LPR)",
            "jurisdiction": "federal"
          },
          {
            "name": "EOIR-42B — Cancellation of Removal (Non-LPR / 10-Year Rule)",
            "jurisdiction": "federal"
          },
          {
            "name": "Master Calendar Hearing (MH) Preparation & Filing",
            "jurisdiction": "federal"
          },
          {
            "name": "Individual Hearing (IH) Preparation & Trial",
            "jurisdiction": "federal"
          },
          {
            "name": "Motion to Terminate Removal Proceedings",
            "jurisdiction": "federal"
          },
          {
            "name": "Motion to Continue / Motion to Transfer Venue",
            "jurisdiction": "federal"
          },
          {
            "name": "Motion to Reopen Removal Proceedings",
            "jurisdiction": "federal"
          },
          {
            "name": "Motion to Reopen Sua Sponte (IJ Discretion)",
            "jurisdiction": "federal"
          },
          {
            "name": "Joint Motion to Reopen",
            "jurisdiction": "federal"
          },
          {
            "name": "Motion to Reconsider",
            "jurisdiction": "federal"
          },
          {
            "name": "Motion to Suppress Evidence",
            "jurisdiction": "federal"
          },
          {
            "name": "Voluntary Departure Request",
            "jurisdiction": "federal"
          },
          {
            "name": "Withholding of Removal — INA §241(b)(3)",
            "jurisdiction": "federal"
          },
          {
            "name": "Convention Against Torture (CAT) Claim",
            "jurisdiction": "federal"
          },
          {
            "name": "Adjustment of Status in Removal Proceedings",
            "jurisdiction": "federal"
          },
          {
            "name": "Bond Hearing — Initial Custody Determination",
            "jurisdiction": "federal"
          },
          {
            "name": "Bond Redetermination Hearing",
            "jurisdiction": "federal"
          },
          {
            "name": "I-246 — Stay of Removal",
            "jurisdiction": "federal"
          },
          {
            "name": "Writ of Mandamus — U.S. District Court",
            "jurisdiction": "federal"
          },
          {
            "name": "Petition for Review — U.S. Circuit Court of Appeals",
            "jurisdiction": "federal"
          },
          {
            "name": "Habeas Corpus (Federal)",
            "jurisdiction": "federal"
          },
          {
            "name": "Prosecutorial Discretion / ICE Deferral Request",
            "jurisdiction": "federal"
          },
          {
            "name": "Deferred Action Request (Non-DACA)",
            "jurisdiction": "federal"
          },
          {
            "name": "Administrative Closure",
            "jurisdiction": "federal"
          },
          {
            "name": "Stipulated Order of Removal",
            "jurisdiction": "federal"
          },
          {
            "name": "Relief Under INA §212(h) — Waiver of Criminal Grounds",
            "jurisdiction": "federal"
          },
          {
            "name": "Relief Under INA §212(i) — Fraud / Misrepresentation Waiver",
            "jurisdiction": "federal"
          },
          {
            "name": "In Absentia Order Reopening",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Citizenship & Naturalization",
        "caseTypes": [
          {
            "name": "N-400 — Application for Naturalization",
            "jurisdiction": "federal"
          },
          {
            "name": "Naturalization — 3-Year Spouse of USC Basis",
            "jurisdiction": "federal"
          },
          {
            "name": "Naturalization — 5-Year LPR Basis",
            "jurisdiction": "federal"
          },
          {
            "name": "N-600 — Certificate of Citizenship (Acquired at Birth)",
            "jurisdiction": "federal"
          },
          {
            "name": "N-600K — Citizenship for Child Abroad",
            "jurisdiction": "federal"
          },
          {
            "name": "N-565 — Replacement Naturalization Certificate",
            "jurisdiction": "federal"
          },
          {
            "name": "Naturalization Denial Appeal — EOIR-26 / U.S. District Court",
            "jurisdiction": "federal"
          },
          {
            "name": "Renunciation of U.S. Citizenship Consultation",
            "jurisdiction": "federal"
          },
          {
            "name": "Expatriation Issues / Lost Citizenship Cases",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Consular Processing & Waivers",
        "caseTypes": [
          {
            "name": "I-601 — Waiver of Grounds of Inadmissibility",
            "jurisdiction": "federal"
          },
          {
            "name": "I-601A — Provisional Unlawful Presence Waiver",
            "jurisdiction": "federal"
          },
          {
            "name": "I-212 — Permission to Reapply After Deportation / Removal",
            "jurisdiction": "federal"
          },
          {
            "name": "I-192 — Advance Permission to Enter as Non-Immigrant (T / U Visa)",
            "jurisdiction": "federal"
          },
          {
            "name": "DS-5540 — Public Charge Questionnaire",
            "jurisdiction": "federal"
          },
          {
            "name": "Consular Liaison & Overseas Document Coordination",
            "jurisdiction": "federal"
          },
          {
            "name": "Administrative Processing / 221(g) Response",
            "jurisdiction": "federal"
          },
          {
            "name": "Visa Revocation Response",
            "jurisdiction": "federal"
          },
          {
            "name": "Prior Visa Denial Reapplication Strategy",
            "jurisdiction": "federal"
          }
        ]
      }
    ]
  },
  {
    "name": "Business & Corporate Law",
    "subcategories": [
      {
        "name": "Entity Formation & Structure",
        "caseTypes": [
          {
            "name": "LLC Formation — Single-Member",
            "jurisdiction": "state"
          },
          {
            "name": "LLC Formation — Multi-Member",
            "jurisdiction": "state"
          },
          {
            "name": "C-Corporation Formation",
            "jurisdiction": "state"
          },
          {
            "name": "S-Corporation Formation & Election",
            "jurisdiction": "federal & state"
          },
          {
            "name": "General Partnership Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Limited Partnership (LP) Formation",
            "jurisdiction": "state"
          },
          {
            "name": "Limited Liability Partnership (LLP)",
            "jurisdiction": "state"
          },
          {
            "name": "Professional Association (PA) / Professional LLC (PLLC)",
            "jurisdiction": "state"
          },
          {
            "name": "Nonprofit Corporation / 501(c)(3) Formation",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Benefit Corporation / B-Corp",
            "jurisdiction": "state"
          },
          {
            "name": "Foreign Entity Registration — Florida",
            "jurisdiction": "state"
          },
          {
            "name": "Registered Agent Services",
            "jurisdiction": "state"
          },
          {
            "name": "Annual Report & Compliance Filings",
            "jurisdiction": "state"
          },
          {
            "name": "Dissolution / Winding Up of Entity",
            "jurisdiction": "state"
          },
          {
            "name": "Reinstatement of Dissolved Entity",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Contracts & Transactional Law",
        "caseTypes": [
          {
            "name": "Business Purchase & Sale Agreement (Asset Purchase)",
            "jurisdiction": "state"
          },
          {
            "name": "Business Purchase & Sale Agreement (Stock / Membership Interest)",
            "jurisdiction": "state"
          },
          {
            "name": "Letter of Intent (LOI) — Binding & Non-Binding",
            "jurisdiction": "state"
          },
          {
            "name": "Asset Purchase vs. Stock Purchase Structuring",
            "jurisdiction": "state"
          },
          {
            "name": "Vendor & Supplier Agreements",
            "jurisdiction": "state"
          },
          {
            "name": "Service Agreements & Consulting Contracts",
            "jurisdiction": "state"
          },
          {
            "name": "Master Service Agreement (MSA)",
            "jurisdiction": "state"
          },
          {
            "name": "Independent Contractor Agreements",
            "jurisdiction": "state"
          },
          {
            "name": "Non-Disclosure Agreement (NDA) — Unilateral & Mutual",
            "jurisdiction": "state"
          },
          {
            "name": "Non-Compete & Non-Solicitation Agreements",
            "jurisdiction": "state"
          },
          {
            "name": "Distribution & Reseller Agreements",
            "jurisdiction": "state"
          },
          {
            "name": "Licensing Agreements (Technology, Brand, Content)",
            "jurisdiction": "state"
          },
          {
            "name": "SaaS / Software Subscription Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Terms of Service & Privacy Policy",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Franchise Disclosure Document (FDD) Review",
            "jurisdiction": "federal & state"
          }
        ]
      },
      {
        "name": "Corporate Governance",
        "caseTypes": [
          {
            "name": "Operating Agreement Drafting & Negotiation",
            "jurisdiction": "state"
          },
          {
            "name": "Bylaws Drafting & Amendment",
            "jurisdiction": "state"
          },
          {
            "name": "Shareholder Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Board Resolutions & Corporate Minutes",
            "jurisdiction": "state"
          },
          {
            "name": "Officer & Director Employment Agreements",
            "jurisdiction": "state"
          },
          {
            "name": "Equity / Membership Interest Transfers",
            "jurisdiction": "state"
          },
          {
            "name": "Stock Certificate Issuance",
            "jurisdiction": "state"
          },
          {
            "name": "Voting Agreement / Voting Trust",
            "jurisdiction": "state"
          },
          {
            "name": "Buy-Sell Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Drag-Along & Tag-Along Rights",
            "jurisdiction": "state"
          },
          {
            "name": "Right of First Refusal / Right of First Offer",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Mergers, Acquisitions & Private Finance",
        "caseTypes": [
          {
            "name": "M&A Due Diligence",
            "jurisdiction": "state"
          },
          {
            "name": "Merger Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Acquisition Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Asset Purchase Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Private Placement Memorandum (PPM)",
            "jurisdiction": "federal"
          },
          {
            "name": "SAFE Agreement — Simple Agreement for Future Equity",
            "jurisdiction": "state"
          },
          {
            "name": "Convertible Note",
            "jurisdiction": "state"
          },
          {
            "name": "Investor Rights Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Cap Table Management",
            "jurisdiction": "state"
          },
          {
            "name": "Term Sheet Negotiation",
            "jurisdiction": "state"
          },
          {
            "name": "Series A / B / Seed Round Documentation",
            "jurisdiction": "state"
          },
          {
            "name": "Regulation D (506(b) / 506(c)) Exemption Compliance",
            "jurisdiction": "federal"
          },
          {
            "name": "Regulation Crowdfunding (Reg CF) Compliance",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Intellectual Property",
        "caseTypes": [
          {
            "name": "Trademark Search & Clearance",
            "jurisdiction": "federal"
          },
          {
            "name": "Trademark Application — USPTO",
            "jurisdiction": "federal"
          },
          {
            "name": "Trademark Maintenance (Renewals / Section 8 & 15)",
            "jurisdiction": "federal"
          },
          {
            "name": "Trademark Infringement Cease & Desist",
            "jurisdiction": "federal"
          },
          {
            "name": "Copyright Registration",
            "jurisdiction": "federal"
          },
          {
            "name": "Trade Secret Protection Strategy",
            "jurisdiction": "federal & state"
          },
          {
            "name": "IP Licensing Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "IP Assignment Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Work-for-Hire Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Patent Referral Coordination",
            "jurisdiction": "federal"
          },
          {
            "name": "DMCA Takedown Notices",
            "jurisdiction": "federal"
          },
          {
            "name": "Domain Name Dispute (UDRP)",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Regulatory & Compliance",
        "caseTypes": [
          {
            "name": "Florida DBPR Licensing Compliance",
            "jurisdiction": "state"
          },
          {
            "name": "Business Tax Receipt (BTR / Occupational License)",
            "jurisdiction": "state"
          },
          {
            "name": "Sales Tax Registration & Compliance",
            "jurisdiction": "state"
          },
          {
            "name": "Florida Department of Agriculture (FDACS) Licensing",
            "jurisdiction": "state"
          },
          {
            "name": "Professional Licensing (Contractor, Healthcare, etc.)",
            "jurisdiction": "state"
          },
          {
            "name": "ADA Compliance for Business",
            "jurisdiction": "federal"
          },
          {
            "name": "HIPAA Business Associate Agreements",
            "jurisdiction": "federal"
          },
          {
            "name": "FTC / CFPB Compliance",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Business Litigation",
        "caseTypes": [
          {
            "name": "Breach of Contract",
            "jurisdiction": "state"
          },
          {
            "name": "Business Fraud & Misrepresentation",
            "jurisdiction": "state"
          },
          {
            "name": "Business Dissolution — Deadlock / Oppression",
            "jurisdiction": "state"
          },
          {
            "name": "Shareholder Derivative Action",
            "jurisdiction": "state"
          },
          {
            "name": "Partner / Member Dispute",
            "jurisdiction": "state"
          },
          {
            "name": "Tortious Interference with Business Relations",
            "jurisdiction": "state"
          },
          {
            "name": "Unfair Business Practices",
            "jurisdiction": "state"
          },
          {
            "name": "Trade Secret Misappropriation",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Non-Compete Enforcement & Defense",
            "jurisdiction": "state"
          },
          {
            "name": "Business Defamation / Commercial Disparagement",
            "jurisdiction": "state"
          },
          {
            "name": "Injunctive Relief Proceedings",
            "jurisdiction": "state"
          }
        ]
      }
    ]
  },
  {
    "name": "Estate Planning",
    "subcategories": [
      {
        "name": "Core Planning Documents",
        "caseTypes": [
          {
            "name": "Last Will & Testament — Simple",
            "jurisdiction": "state"
          },
          {
            "name": "Last Will & Testament — Complex / Pour-Over",
            "jurisdiction": "state"
          },
          {
            "name": "Revocable Living Trust",
            "jurisdiction": "state"
          },
          {
            "name": "Pour-Over Will",
            "jurisdiction": "state"
          },
          {
            "name": "Durable Power of Attorney — Financial (FL §709)",
            "jurisdiction": "state"
          },
          {
            "name": "Designation of Health Care Surrogate (FL §765)",
            "jurisdiction": "state"
          },
          {
            "name": "Living Will / Advance Directive",
            "jurisdiction": "state"
          },
          {
            "name": "HIPAA Authorization",
            "jurisdiction": "federal"
          },
          {
            "name": "Designation of Pre-Need Guardian",
            "jurisdiction": "state"
          },
          {
            "name": "Personal Property Memorandum",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Trust Planning & Administration",
        "caseTypes": [
          {
            "name": "Irrevocable Life Insurance Trust (ILIT)",
            "jurisdiction": "state"
          },
          {
            "name": "Special Needs Trust — First-Party (d)(4)(A)",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Special Needs Trust — Third-Party",
            "jurisdiction": "state"
          },
          {
            "name": "Pooled Special Needs Trust",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Spendthrift Trust",
            "jurisdiction": "state"
          },
          {
            "name": "Supplemental Needs Trust",
            "jurisdiction": "state"
          },
          {
            "name": "Charitable Remainder Trust (CRT)",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Charitable Lead Trust (CLT)",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Donor-Advised Fund (DAF) Planning",
            "jurisdiction": "federal"
          },
          {
            "name": "Asset Protection Trust",
            "jurisdiction": "state"
          },
          {
            "name": "Dynasty Trust",
            "jurisdiction": "state"
          },
          {
            "name": "Gun Trust",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Pet Trust",
            "jurisdiction": "state"
          },
          {
            "name": "Trust Amendment",
            "jurisdiction": "state"
          },
          {
            "name": "Trust Restatement",
            "jurisdiction": "state"
          },
          {
            "name": "Trust Administration & Funding",
            "jurisdiction": "state"
          },
          {
            "name": "Trustee Resignation & Successor Trustee Appointment",
            "jurisdiction": "state"
          },
          {
            "name": "Trust Decanting",
            "jurisdiction": "state"
          },
          {
            "name": "Trust Modification / Judicial Reform",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Estate & Gift Tax Planning",
        "caseTypes": [
          {
            "name": "Annual Gift Exclusion Planning ($18,000 per donee / 2024)",
            "jurisdiction": "federal"
          },
          {
            "name": "Lifetime Exemption Planning (Federal & Florida)",
            "jurisdiction": "federal"
          },
          {
            "name": "Spousal Portability Election (Estate Tax)",
            "jurisdiction": "federal"
          },
          {
            "name": "Generation-Skipping Transfer (GST) Tax Planning",
            "jurisdiction": "federal"
          },
          {
            "name": "Qualified Personal Residence Trust (QPRT)",
            "jurisdiction": "federal"
          },
          {
            "name": "Grantor Retained Annuity Trust (GRAT)",
            "jurisdiction": "federal"
          },
          {
            "name": "Grantor Retained Unitrust (GRUT)",
            "jurisdiction": "federal"
          },
          {
            "name": "Intentionally Defective Grantor Trust (IDGT)",
            "jurisdiction": "federal"
          },
          {
            "name": "Family Limited Partnership (FLP)",
            "jurisdiction": "state"
          },
          {
            "name": "Family Limited Liability Company (FLLC)",
            "jurisdiction": "state"
          },
          {
            "name": "Spousal Lifetime Access Trust (SLAT)",
            "jurisdiction": "federal"
          },
          {
            "name": "Irrevocable Trusts for Tax Minimization",
            "jurisdiction": "federal"
          },
          {
            "name": "Qualified Opportunity Zone Planning",
            "jurisdiction": "federal"
          },
          {
            "name": "Estate Tax Return (Form 706) Coordination",
            "jurisdiction": "federal"
          },
          {
            "name": "Gift Tax Return (Form 709) Coordination",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Probate & Estate Administration",
        "caseTypes": [
          {
            "name": "Summary Administration (Estates Under $75,000 or Over 2 Years)",
            "jurisdiction": "state"
          },
          {
            "name": "Formal Administration",
            "jurisdiction": "state"
          },
          {
            "name": "Ancillary Probate — Out-of-State / Overseas Property",
            "jurisdiction": "state"
          },
          {
            "name": "Disposition of Personal Property Without Administration",
            "jurisdiction": "state"
          },
          {
            "name": "Creditor Claim Resolution",
            "jurisdiction": "state"
          },
          {
            "name": "Estate Litigation — Will Contest",
            "jurisdiction": "state"
          },
          {
            "name": "Undue Influence Defense",
            "jurisdiction": "state"
          },
          {
            "name": "Lack of Testamentary Capacity Defense",
            "jurisdiction": "state"
          },
          {
            "name": "Fraud & Forgery in Estate Documents",
            "jurisdiction": "state"
          },
          {
            "name": "Elective Share (Surviving Spouse — FL §732.2065)",
            "jurisdiction": "state"
          },
          {
            "name": "Pretermitted Spouse / Child Claims",
            "jurisdiction": "state"
          },
          {
            "name": "Heirship Determination / Intestate Succession",
            "jurisdiction": "state"
          },
          {
            "name": "Homestead Determination (FL Art. X §4)",
            "jurisdiction": "state"
          },
          {
            "name": "Personal Representative Duties & Defense",
            "jurisdiction": "state"
          },
          {
            "name": "Trustee Surcharge / Breach of Fiduciary Duty",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Business Succession",
        "caseTypes": [
          {
            "name": "Buy-Sell Agreement — Cross-Purchase & Entity Redemption",
            "jurisdiction": "state"
          },
          {
            "name": "Succession Planning for Closely Held Business",
            "jurisdiction": "state"
          },
          {
            "name": "Key Person Life Insurance Strategy",
            "jurisdiction": "state"
          },
          {
            "name": "ESOP — Employee Stock Ownership Plan Coordination",
            "jurisdiction": "federal"
          },
          {
            "name": "Transfer of Business Interests to Trust",
            "jurisdiction": "state"
          },
          {
            "name": "Installment Sale to Grantor Trust",
            "jurisdiction": "federal"
          },
          {
            "name": "Management Transition Planning",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Elder Law",
        "caseTypes": [
          {
            "name": "Medicaid Planning & Asset Protection",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Medicaid Application Assistance",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Medicaid Lookback Period Strategy",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Long-Term Care Planning",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Miller Trust (Qualified Income Trust)",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Guardianship of Incapacitated Adult — Petition",
            "jurisdiction": "state"
          },
          {
            "name": "Guardianship of Minor — Petition",
            "jurisdiction": "state"
          },
          {
            "name": "Veterans' Benefits Planning (Aid & Attendance)",
            "jurisdiction": "federal"
          },
          {
            "name": "Elder Abuse & Financial Exploitation Cases",
            "jurisdiction": "state"
          }
        ]
      }
    ]
  },
  {
    "name": "Employment Law",
    "subcategories": [
      {
        "name": "Workplace Discrimination",
        "caseTypes": [
          {
            "name": "Title VII — Race, Color, Religion, Sex, National Origin",
            "jurisdiction": "federal"
          },
          {
            "name": "Age Discrimination — ADEA (40+)",
            "jurisdiction": "federal"
          },
          {
            "name": "Americans with Disabilities Act (ADA) — Discrimination",
            "jurisdiction": "federal"
          },
          {
            "name": "Pregnancy Discrimination Act (PDA)",
            "jurisdiction": "federal"
          },
          {
            "name": "Pregnant Workers Fairness Act (PWFA)",
            "jurisdiction": "federal"
          },
          {
            "name": "PUMP Act — Lactation Accommodation",
            "jurisdiction": "federal"
          },
          {
            "name": "Florida Civil Rights Act (FCRA) Claims",
            "jurisdiction": "state"
          },
          {
            "name": "Equal Pay Act / Gender Pay Gap Claims",
            "jurisdiction": "federal"
          },
          {
            "name": "Section 1981 — Race Discrimination in Contracting",
            "jurisdiction": "federal"
          },
          {
            "name": "EEOC Charge Filing",
            "jurisdiction": "federal"
          },
          {
            "name": "EEOC Mediation / Conciliation",
            "jurisdiction": "federal"
          },
          {
            "name": "EEOC Right-to-Sue Letter — Federal Court Complaint",
            "jurisdiction": "federal"
          },
          {
            "name": "FCHR Complaint — Florida Commission on Human Relations",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Harassment & Retaliation",
        "caseTypes": [
          {
            "name": "Sexual Harassment — Quid Pro Quo",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Sexual Harassment — Hostile Work Environment",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Same-Sex / Gender Identity Harassment",
            "jurisdiction": "federal"
          },
          {
            "name": "Retaliation for Protected Activity (Title VII, ADA, ADEA)",
            "jurisdiction": "federal"
          },
          {
            "name": "Retaliation for Workers' Compensation Claim",
            "jurisdiction": "state"
          },
          {
            "name": "Retaliation for FMLA Leave",
            "jurisdiction": "federal"
          },
          {
            "name": "Whistleblower Retaliation — Florida Whistle-blower Act",
            "jurisdiction": "state"
          },
          {
            "name": "OSHA Anti-Retaliation Complaint",
            "jurisdiction": "federal"
          },
          {
            "name": "Sarbanes-Oxley (SOX) Whistleblower",
            "jurisdiction": "federal"
          },
          {
            "name": "False Claims Act (Qui Tam) Whistleblower",
            "jurisdiction": "federal"
          },
          {
            "name": "Internal Workplace Investigation Support",
            "jurisdiction": "federal & state"
          },
          {
            "name": "HR Policy Drafting & Anti-Harassment Training",
            "jurisdiction": "federal & state"
          }
        ]
      },
      {
        "name": "Wage & Hour",
        "caseTypes": [
          {
            "name": "FLSA — Overtime Violations (7(i), Administrative, Executive Exemptions)",
            "jurisdiction": "federal"
          },
          {
            "name": "FLSA — Minimum Wage Violations",
            "jurisdiction": "federal"
          },
          {
            "name": "Florida Minimum Wage Violations (Art. X §24)",
            "jurisdiction": "state"
          },
          {
            "name": "Employee vs. Independent Contractor Misclassification",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Exempt vs. Non-Exempt Misclassification",
            "jurisdiction": "federal"
          },
          {
            "name": "Unpaid Wages / Withheld Commission Disputes",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Tip Credit & Tip Pooling Violations",
            "jurisdiction": "federal"
          },
          {
            "name": "Off-the-Clock Work Claims",
            "jurisdiction": "federal"
          },
          {
            "name": "Meal & Rest Break Violations",
            "jurisdiction": "state"
          },
          {
            "name": "FLSA Class / Collective Action (§216(b))",
            "jurisdiction": "federal"
          },
          {
            "name": "Florida Class Action — Wage Theft",
            "jurisdiction": "state"
          },
          {
            "name": "Department of Labor (DOL) Investigation Response",
            "jurisdiction": "federal"
          },
          {
            "name": "Back Pay & Liquidated Damages Recovery",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Leave & Accommodation",
        "caseTypes": [
          {
            "name": "FMLA Compliance — Policy & Administration",
            "jurisdiction": "federal"
          },
          {
            "name": "FMLA Interference & Retaliation Claims",
            "jurisdiction": "federal"
          },
          {
            "name": "ADA Reasonable Accommodation Request / Denial",
            "jurisdiction": "federal"
          },
          {
            "name": "Interactive Process Obligations",
            "jurisdiction": "federal"
          },
          {
            "name": "Undue Hardship Defense",
            "jurisdiction": "federal"
          },
          {
            "name": "Florida Sick Time & Local Ordinance Compliance",
            "jurisdiction": "state"
          },
          {
            "name": "Military Leave — USERRA Compliance",
            "jurisdiction": "federal"
          },
          {
            "name": "Parental Leave / FMLA for Bonding",
            "jurisdiction": "federal"
          }
        ]
      },
      {
        "name": "Employment Agreements & Policies",
        "caseTypes": [
          {
            "name": "Executive Employment Contract",
            "jurisdiction": "state"
          },
          {
            "name": "At-Will Employment Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Non-Compete Agreement — Drafting & Negotiation",
            "jurisdiction": "state"
          },
          {
            "name": "Non-Compete Agreement — Enforcement & Defense (FL §542.335)",
            "jurisdiction": "state"
          },
          {
            "name": "Non-Solicitation Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Confidentiality / NDA Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Trade Secret Protection — Defend Trade Secrets Act (DTSA)",
            "jurisdiction": "federal"
          },
          {
            "name": "Severance & Separation Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "ADEA Waiver / Olderworker Benefits Protection Act Compliance",
            "jurisdiction": "federal"
          },
          {
            "name": "Arbitration Agreement — Drafting & Enforcement",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Class Action Waiver",
            "jurisdiction": "federal"
          },
          {
            "name": "Employee Handbook — Drafting, Review & Update",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Independent Contractor Agreement",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Termination",
        "caseTypes": [
          {
            "name": "Wrongful Termination — At-Will Exceptions",
            "jurisdiction": "state"
          },
          {
            "name": "Constructive Discharge",
            "jurisdiction": "federal & state"
          },
          {
            "name": "For-Cause Termination Defense",
            "jurisdiction": "state"
          },
          {
            "name": "Reduction in Force (RIF) Planning",
            "jurisdiction": "state"
          },
          {
            "name": "WARN Act Compliance (100+ Employees / Mass Layoffs)",
            "jurisdiction": "federal"
          },
          {
            "name": "Mini-WARN Act (State Level)",
            "jurisdiction": "state"
          },
          {
            "name": "Unemployment Compensation Appeals",
            "jurisdiction": "state"
          },
          {
            "name": "Employer Misconduct / Unemployment Benefit Defense",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Immigration in Employment Context",
        "caseTypes": [
          {
            "name": "I-9 Compliance Audit & Training",
            "jurisdiction": "federal"
          },
          {
            "name": "E-Verify Program Enrollment & Management",
            "jurisdiction": "federal"
          },
          {
            "name": "ICE Audit Response & Defense",
            "jurisdiction": "federal"
          },
          {
            "name": "H-1B Employer Obligations & LCA Compliance",
            "jurisdiction": "federal"
          },
          {
            "name": "H-2A / H-2B Employer Compliance",
            "jurisdiction": "federal"
          },
          {
            "name": "Employer Sanctions Defense",
            "jurisdiction": "federal"
          },
          {
            "name": "Deferred Action / Work Authorization Coordination",
            "jurisdiction": "federal"
          }
        ]
      }
    ]
  },
  {
    "name": "Real Estate Law",
    "subcategories": [
      {
        "name": "Residential Transactions",
        "caseTypes": [
          {
            "name": "Purchase & Sale Agreement — Drafting & Review",
            "jurisdiction": "state"
          },
          {
            "name": "AS-IS Contract Review (FAR/BAR)",
            "jurisdiction": "state"
          },
          {
            "name": "Buyer Representation & Due Diligence",
            "jurisdiction": "state"
          },
          {
            "name": "Seller Representation",
            "jurisdiction": "state"
          },
          {
            "name": "Title Search & Examination",
            "jurisdiction": "state"
          },
          {
            "name": "Title Insurance — Owner's & Lender's Policy",
            "jurisdiction": "state"
          },
          {
            "name": "Closing / Settlement Services",
            "jurisdiction": "state"
          },
          {
            "name": "FIRPTA Withholding Compliance (Foreign Sellers)",
            "jurisdiction": "federal"
          },
          {
            "name": "1031 Like-Kind Exchange — Forward & Reverse",
            "jurisdiction": "federal"
          },
          {
            "name": "Short Sale Negotiation",
            "jurisdiction": "state"
          },
          {
            "name": "Foreclosure Defense",
            "jurisdiction": "state"
          },
          {
            "name": "Deed-in-Lieu of Foreclosure",
            "jurisdiction": "state"
          },
          {
            "name": "RESPA / TILA Compliance",
            "jurisdiction": "federal"
          },
          {
            "name": "Homestead Exemption Analysis",
            "jurisdiction": "state"
          },
          {
            "name": "New Construction Contract Review",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Commercial Transactions",
        "caseTypes": [
          {
            "name": "Commercial Purchase & Sale Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Commercial Due Diligence",
            "jurisdiction": "state"
          },
          {
            "name": "Commercial Lease — Drafting & Negotiation (Office / Retail / Industrial)",
            "jurisdiction": "state"
          },
          {
            "name": "Ground Lease Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Sale-Leaseback Structuring",
            "jurisdiction": "state"
          },
          {
            "name": "Portfolio Acquisition & Disposition",
            "jurisdiction": "state"
          },
          {
            "name": "Letter of Intent (LOI) — Commercial Real Estate",
            "jurisdiction": "state"
          },
          {
            "name": "1031 Exchange — Commercial Property",
            "jurisdiction": "federal"
          },
          {
            "name": "Tenant Representation",
            "jurisdiction": "state"
          },
          {
            "name": "Landlord Representation",
            "jurisdiction": "state"
          },
          {
            "name": "Assignment & Subletting Agreements",
            "jurisdiction": "state"
          },
          {
            "name": "Lease Guaranty",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Financing & Lending",
        "caseTypes": [
          {
            "name": "Mortgage / Deed of Trust Review",
            "jurisdiction": "state"
          },
          {
            "name": "Promissory Note Drafting",
            "jurisdiction": "state"
          },
          {
            "name": "Hard Money Loan Documentation",
            "jurisdiction": "state"
          },
          {
            "name": "Private Lending Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Construction Loan Compliance & Draw Review",
            "jurisdiction": "state"
          },
          {
            "name": "Mezzanine Financing",
            "jurisdiction": "state"
          },
          {
            "name": "CMBS Loan Documents",
            "jurisdiction": "federal"
          },
          {
            "name": "Loan Assumption",
            "jurisdiction": "state"
          },
          {
            "name": "Loan Modification & Workout",
            "jurisdiction": "state"
          },
          {
            "name": "UCC Fixture Filing",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Subordination, Non-Disturbance & Attornment (SNDA)",
            "jurisdiction": "state"
          },
          {
            "name": "Estoppel Certificate",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Land Use, Zoning & Development",
        "caseTypes": [
          {
            "name": "Zoning Application & Variance",
            "jurisdiction": "state"
          },
          {
            "name": "Rezoning / Future Land Use Map Amendment",
            "jurisdiction": "state"
          },
          {
            "name": "Special Exception / Conditional Use",
            "jurisdiction": "state"
          },
          {
            "name": "Development Agreement",
            "jurisdiction": "state"
          },
          {
            "name": "Planned Unit Development (PUD)",
            "jurisdiction": "state"
          },
          {
            "name": "Environmental Compliance & Phase I/II Coordination",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Wetlands / Environmental Permitting Coordination",
            "jurisdiction": "federal & state"
          },
          {
            "name": "Subdivision Platting",
            "jurisdiction": "state"
          },
          {
            "name": "Easement — Grant, Reservation & Termination",
            "jurisdiction": "state"
          },
          {
            "name": "Rights of Way Dedication",
            "jurisdiction": "state"
          },
          {
            "name": "HOA / Condominium Declaration Drafting",
            "jurisdiction": "state"
          },
          {
            "name": "HOA / Condominium Amendments",
            "jurisdiction": "state"
          },
          {
            "name": "Restrictive Covenant Enforcement & Modification",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Landlord-Tenant",
        "caseTypes": [
          {
            "name": "Residential Lease Drafting",
            "jurisdiction": "state"
          },
          {
            "name": "Commercial Lease Drafting",
            "jurisdiction": "state"
          },
          {
            "name": "Eviction — Residential (FL §83 — 3-Day / 7-Day Notice)",
            "jurisdiction": "state"
          },
          {
            "name": "Eviction — Commercial (FL §83.20)",
            "jurisdiction": "state"
          },
          {
            "name": "Unlawful Detainer",
            "jurisdiction": "state"
          },
          {
            "name": "Security Deposit Disputes",
            "jurisdiction": "state"
          },
          {
            "name": "Habitability / Code Violation Claims",
            "jurisdiction": "state"
          },
          {
            "name": "Tenant Defense Against Eviction",
            "jurisdiction": "state"
          },
          {
            "name": "Lease Renewal & Holdover Tenant",
            "jurisdiction": "state"
          },
          {
            "name": "Rent Collection & Judgment",
            "jurisdiction": "state"
          }
        ]
      },
      {
        "name": "Real Estate Litigation",
        "caseTypes": [
          {
            "name": "Breach of Purchase Contract",
            "jurisdiction": "state"
          },
          {
            "name": "Specific Performance Action",
            "jurisdiction": "state"
          },
          {
            "name": "Quiet Title Action",
            "jurisdiction": "state"
          },
          {
            "name": "Partition Action",
            "jurisdiction": "state"
          },
          {
            "name": "Boundary / Survey / Encroachment Disputes",
            "jurisdiction": "state"
          },
          {
            "name": "Adverse Possession Claim",
            "jurisdiction": "state"
          },
          {
            "name": "Easement Dispute",
            "jurisdiction": "state"
          },
          {
            "name": "Mechanic's Lien — Filing, Enforcement & Defense (FL Ch. 713)",
            "jurisdiction": "state"
          },
          {
            "name": "Construction Defect Claims",
            "jurisdiction": "state"
          },
          {
            "name": "Fraudulent Conveyance / Transfer",
            "jurisdiction": "state"
          },
          {
            "name": "Real Estate Fraud",
            "jurisdiction": "state"
          },
          {
            "name": "Breach of Fiduciary Duty — Real Estate Agent",
            "jurisdiction": "state"
          },
          {
            "name": "Lis Pendens",
            "jurisdiction": "state"
          }
        ]
      }
    ]
  }
] as const satisfies readonly TaxonomyPracticeArea[];
