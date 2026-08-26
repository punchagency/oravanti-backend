import { describe, expect, it } from "@jest/globals";
import { dateAnchorEnum } from "../../../src/db/schema/document-requirements";
import type { Condition } from "../../../src/db/schema/workflow";
import { SYSTEM_TEMPLATES, type ModuleDef } from "../../../src/db/seeds/workflow-template.seed";
import { fieldsReferencedBy } from "../../../src/modules/workflow/condition-evaluator";
import { CONDITION_FIELDS } from "../../../src/modules/workflow/workflow-template.validation";

/*
  The four system-default templates are ~220 hand-transcribed steps carrying
  statutory deadlines. Nothing about them is type-checked beyond their shape:
  a wrong anchor name, a role that doesn't exist, a condition on a module that
  never evaluates one — all compile, all fail silently at runtime, and the
  failure mode is a limitation deadline that never appears on anyone's screen.

  So this asserts the conventions `04-personal-injury-template.md` and
  `05-immigration-template.md` state once and apply throughout, plus the
  headline counts from their own module tables. A deliberate change to a
  template updates the plan doc and the number here together; an accidental
  one fails.
*/

const TEMPLATES = Object.values(SYSTEM_TEMPLATES);
const allModules = (): ModuleDef[] => TEMPLATES.flatMap((t) => t.modules);
const allSteps = () => allModules().flatMap((m) => m.steps);

/** The live baseline role pack. See the seed file header on why specializations collapse onto these. */
const REAL_ROLES = new Set(["attorney", "paralegal", "legal_assistant"]);

const VALID_ANCHORS = new Set<string>(dateAnchorEnum.enumValues);

describe("module and step counts match the plan documents", () => {
  // 04 § 1 and 05 §§ 1–3 module tables. Change a number here only alongside
  // the doc it came from.
  it.each([
    ["personalInjury", 20, 135],
    ["adjustmentOfStatus", 10, 38],
    ["naturalization", 7, 28],
    ["mandamus", 8, 23],
  ] as const)("%s has %i modules and %i steps", (key, modules, steps) => {
    const template = SYSTEM_TEMPLATES[key];

    expect(template.modules).toHaveLength(modules);
    expect(template.modules.reduce((sum, m) => sum + m.steps.length, 0)).toBe(steps);
  });
});

describe("structural invariants", () => {
  it("numbers modules contiguously from 1 within each template", () => {
    for (const template of TEMPLATES) {
      expect(template.modules.map((m) => m.orderIndex)).toEqual(
        template.modules.map((_, i) => i + 1),
      );
    }
  });

  it("numbers steps contiguously from 1 within each module", () => {
    const broken = allModules()
      .filter((m) => m.steps.some((s, i) => s.orderIndex !== i + 1))
      .map((m) => m.name);

    expect(broken).toEqual([]);
  });

  it("gives every module a phase and at least one step", () => {
    const empty = allModules()
      .filter((m) => !m.phase.trim() || m.steps.length === 0)
      .map((m) => m.name);

    expect(empty).toEqual([]);
  });

  it("gives every step a title", () => {
    expect(allSteps().filter((s) => !s.title.trim())).toEqual([]);
  });
});

describe("assignment", () => {
  /*
    Materialization only calls `pickBestAssignee` when a step has at least one
    assignable role (`if (step.assignableRoles.length > 0)`). A module with an
    empty list therefore materializes tasks that are never auto-assigned — the
    exact bug an earlier draft of this seed shipped.
  */
  it("gives every module at least one assignable role", () => {
    const unassignable = allModules()
      .filter((m) => m.assignableRoles.length === 0)
      .map((m) => m.name);

    expect(unassignable).toEqual([]);
  });

  it("names only roles that exist in the baseline role pack", () => {
    const unknown = new Set<string>();
    for (const mod of allModules()) {
      for (const role of [...mod.assignableRoles, ...(mod.steps.flatMap((s) => s.assignableRoles ?? []))]) {
        if (!REAL_ROLES.has(role)) unknown.add(role);
      }
    }

    expect([...unknown]).toEqual([]);
  });
});

describe("due-date anchors", () => {
  it("uses only values from the date_anchor enum", () => {
    const unknown = new Set(
      allSteps()
        .map((s) => s.dueDateAnchor)
        .filter((a): a is (typeof dateAnchorEnum.enumValues)[number] => Boolean(a) && !VALID_ANCHORS.has(a as string)),
    );

    expect([...unknown]).toEqual([]);
  });

  it("pairs every anchor with an offset and every offset with an anchor", () => {
    // `resolveDueDate` returns null unless BOTH are set, so a half-specified
    // step silently never gets a due date.
    const halfSpecified = allSteps()
      .filter((s) => (s.dueDateAnchor === undefined) !== (s.dueDateOffsetDays === undefined))
      .map((s) => s.title);

    expect(halfSpecified).toEqual([]);
  });

  it("keeps the SOL reminder cascade counting down, not up", () => {
    // 04 § Module 1: three locked reminders at −180/−90/−30. A positive offset
    // here would schedule the reminder *after* the limitation period expired.
    const reminders = SYSTEM_TEMPLATES.personalInjury.modules[0].steps.filter(
      (s) => s.dueDateAnchor === "statute_of_limitations_date",
    );

    expect(reminders.map((s) => s.dueDateOffsetDays)).toEqual([-180, -90, -30]);
    expect(reminders.every((s) => s.isLocked)).toBe(true);
  });
});

describe("conditional activation", () => {
  it("gives every conditional module a condition, and no other module one", () => {
    const wrong = allModules()
      .filter((m) => (m.activationType === "conditional") !== Boolean(m.activationCondition))
      .map((m) => `${m.name} (${m.activationType})`);

    expect(wrong).toEqual([]);
  });

  it("references only fields the evaluator can resolve", () => {
    // A field outside the union evaluates false forever, so the module never
    // activates and its tasks simply never appear — close to undebuggable
    // from the outside.
    // Uses the evaluator's own recursive walk rather than reading `.field`
    // directly: a composite (`anyOf`/`allOf`) has no `.field`, so the flat read
    // this used to do yielded `undefined` for every one — and `toEqual([])`
    // ignores undefined array entries, so the whole check passed vacuously the
    // moment the first composite condition entered the seed.
    const fields = allModules()
      .map((m) => m.activationCondition)
      .filter((c): c is Condition => Boolean(c))
      .flatMap(fieldsReferencedBy);

    const unknown = fields.filter((f) => !(CONDITION_FIELDS as readonly string[]).includes(f));

    // toStrictEqual, not toEqual — see above.
    expect(unknown).toStrictEqual([]);
    // And prove the walk actually reached the composites, so this can never go
    // quiet again the way it just did.
    expect(fields).toContain("immigrationDetails.priorityDateIsCurrent");
  });

  it("gates exactly the modules the plans say it gates", () => {
    /*
      04 § 3 — one condition, on the government pre-suit notice module.
      05 § 4 — AOS Modules 2b AND 5 open on either filing track (the same
      condition on two modules, which is why this asserts module names rather
      than a de-duplicated set of conditions); `isConditionalResidence` gates
      Module 9. N-400 and Mandamus are single-path and use none.

      The two AOS package modules are deliberately NOT gated on
      `filingTrack = concurrent` alone. That was the original shape and it left
      every sequential (preference-category) matter without I-485 package steps
      for the whole life of the case, including the month its priority date
      became current. They now open on either track — concurrently from day one,
      or sequentially once a visa number is available.

      Listed by module so a failure says *what* changed, not just that a count
      moved.
    */
    const render = (c: Condition): string =>
      "anyOf" in c
        ? `(${c.anyOf.map(render).join(" OR ")})`
        : "allOf" in c
          ? `(${c.allOf.map(render).join(" AND ")})`
          : `${c.field} ${c.op} ${String(c.value)}`;

    const gated = allModules()
      .filter((m) => m.activationCondition)
      .map((m) => `${m.name} ← ${render(m.activationCondition as Condition)}`)
      .sort();

    const FILEABLE =
      "(immigrationDetails.filingTrack eq concurrent OR immigrationDetails.priorityDateIsCurrent eq true)";

    expect(gated).toEqual([
      `AOS Package Assembly (I-485 / I-765 / I-131 / I-864 / I-693) ← ${FILEABLE}`,
      `EAD / Advance Parole (Combo Card) ← ${FILEABLE}`,
      "Government Pre-Suit Notice ← personalInjuryDetails.defendantType eq government_entity",
      "I-751 Removal of Conditions ← immigrationDetails.isConditionalResidence eq true",
    ]);
  });

  it("leaves the whole PI litigation phase on manual activation", () => {
    /*
      04 § 1: litigation is not the default path for a PI matter, and each
      litigation module gates on a real-world event (opposing counsel's filing,
      court scheduling, a verdict) the system cannot observe. Modules 11–20 are
      therefore manual, module 2 is the one conditional, and the remaining nine
      are auto.

      ⚠️ 04's prose says "11 of 20 are manual" but its own module table marks
      exactly ten (11 through 20). The table is what this seed was transcribed
      from and what these numbers assert; the prose sentence is a spec typo.

      Pinned because manual is the one activation type whole-case
      materialization deliberately skips, so those modules reach a case only
      through `materializeModule`. When that call was missing from
      `activateModule`, all ten were unreachable and the litigation half of
      every PI matter could not be opened at all.
    */
    const byType = SYSTEM_TEMPLATES.personalInjury.modules.reduce<Record<string, number>>(
      (acc, m) => ({ ...acc, [m.activationType]: (acc[m.activationType] ?? 0) + 1 }),
      {},
    );

    expect(byType).toEqual({ auto: 9, conditional: 1, manual: 10 });

    // And they are the last ten, not ten scattered through the lifecycle.
    const manualIndexes = SYSTEM_TEMPLATES.personalInjury.modules
      .filter((m) => m.activationType === "manual")
      .map((m) => m.orderIndex);

    expect(manualIndexes).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it("uses no module-level condition in N-400 or Mandamus", () => {
    // 05 § 4: both are single-path once opened.
    for (const key of ["naturalization", "mandamus"] as const) {
      const gated = SYSTEM_TEMPLATES[key].modules.filter((m) => m.activationCondition);
      expect(gated).toEqual([]);
    }
  });
});

describe("locked backbone", () => {
  it("locks steps in every template", () => {
    // A template with nothing locked has no backbone at all — a firm could
    // delete its statutory deadlines outright.
    for (const template of TEMPLATES) {
      const locked = template.modules.flatMap((m) => m.steps).filter((s) => s.isLocked);
      expect(locked.length).toBeGreaterThan(0);
    }
  });

  it("anchors most locked steps to a date", () => {
    /*
      04 § Governing conventions: locked means statutory/malpractice/trust
      exposure — deadline calculation, notices, service, filing. Those are
      overwhelmingly dated. A few are genuinely event-triggered (a court's
      ruling, an opposing party's filing) and correctly carry a null anchor,
      so this is a ratio check, not an absolute: it catches a bulk edit that
      strips anchors, without forbidding the documented exceptions.
    */
    const locked = allSteps().filter((s) => s.isLocked);
    const anchored = locked.filter((s) => s.dueDateAnchor);

    expect(anchored.length / locked.length).toBeGreaterThan(0.6);
  });
});

describe("certifications", () => {
  it("declares none, on any step", () => {
    /*
      Both plans say so outright. This is not cosmetic: an invented
      certification name matches no `certifications` row, `pickBestAssignee`
      finds nobody who holds it, and every step in the module silently
      materializes unassigned. An earlier draft of this seed did exactly that.

      `requiredCertifications` is written as `[]` at insert time, so the
      guarantee is that no step definition tries to carry one.
    */
    const withCerts = allSteps().filter(
      (s) => "requiredCertifications" in s && (s as { requiredCertifications?: unknown[] }).requiredCertifications?.length,
    );

    expect(withCerts).toEqual([]);
  });
});
