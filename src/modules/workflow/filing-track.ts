/**
 * Who may petition whom, and what that means for how the case is filed.
 *
 * A direct transcription of § 1.1 of the source document. Deliberately pure — no
 * database, no imports from the rest of the module — because this is the kind of
 * table that is worth reading against the statute line by line, and a reviewer
 * should be able to do that without holding any of the engine in their head.
 *
 * One function returns both the track and the preference category because they
 * come off the same two-column table. Splitting them would mean two functions
 * walking the same branches, and eventually disagreeing.
 */

export type PetitionerStatus = "usc" | "lpr";

export type RelationshipCategory =
  | "spouse"
  | "parent"
  | "child_under_21"
  | "unmarried_child_over_21"
  | "married_child"
  | "sibling";

/** Immediate relative, or one of the five family preference categories. */
export type PreferenceCategory = "ir" | "f1" | "f2a" | "f2b" | "f3" | "f4";

export type FilingTrack = "concurrent" | "sequential";

/**
 * What the § 1.1 table says about one petitioner/beneficiary pair.
 *
 * The `petitionable: false` arm is not defensive padding — it is the law. An LPR
 * cannot petition a parent, a sibling, or a married son or daughter at all.
 * Those three combinations have no preference category to fall back to, and
 * returning a plausible-looking one would put a case on a track it can never
 * complete. The UI shows the reason instead.
 */
export type FilingEligibility =
  | {
      petitionable: true;
      filingTrack: FilingTrack;
      preferenceCategory: PreferenceCategory;
    }
  | { petitionable: false; reason: string };

/**
 * The § 1.1 table, as data.
 *
 * `null` marks a relationship the petitioner's status does not permit, with the
 * reason given in `NOT_PETITIONABLE` below. Written as a lookup rather than a
 * chain of conditionals so that it reads like the table it came from and a
 * missing combination is a visible hole rather than a fall-through.
 */
const PREFERENCE_CATEGORY: Record<
  PetitionerStatus,
  Record<RelationshipCategory, PreferenceCategory | null>
> = {
  usc: {
    spouse: "ir",
    parent: "ir",
    child_under_21: "ir",
    unmarried_child_over_21: "f1",
    married_child: "f3",
    sibling: "f4",
  },
  lpr: {
    spouse: "f2a",
    parent: null,
    child_under_21: "f2a",
    unmarried_child_over_21: "f2b",
    married_child: null,
    sibling: null,
  },
};

/** Why a combination has no category. Shown to the user, so worded for one. */
const NOT_PETITIONABLE: Partial<Record<RelationshipCategory, string>> = {
  parent: "A lawful permanent resident cannot petition for a parent. Only a U.S. citizen aged 21 or over can.",
  married_child: "A lawful permanent resident cannot petition for a married son or daughter. Only a U.S. citizen can.",
  sibling: "A lawful permanent resident cannot petition for a sibling. Only a U.S. citizen aged 21 or over can.",
};

/**
 * Immediate relatives of a U.S. citizen are not subject to the annual numerical
 * limits, so a visa is always available and the I-130 and I-485 go in together.
 * Every preference category competes for a capped number of visas, which is what
 * the priority date and the Visa Bulletin exist to ration — those file the I-130
 * first and wait.
 */
export function deriveFilingEligibility(
  petitionerStatus: PetitionerStatus,
  relationship: RelationshipCategory,
): FilingEligibility {
  const preferenceCategory = PREFERENCE_CATEGORY[petitionerStatus][relationship];

  if (preferenceCategory === null) {
    return {
      petitionable: false,
      reason: NOT_PETITIONABLE[relationship] ?? "This petitioner cannot file for this relationship.",
    };
  }

  return {
    petitionable: true,
    preferenceCategory,
    // The IR category IS the "no numerical limit" category, so this is the same
    // statement as the one above rather than a second, separately maintained rule.
    filingTrack: preferenceCategory === "ir" ? "concurrent" : "sequential",
  };
}
