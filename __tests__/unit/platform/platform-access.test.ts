import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
  The boundary between Oravanti and the firms that pay it.

  Everything under `/platform` writes global reference data: one row decides
  what an I-485 asks, which question fills each box, and what every firm's
  clients are asked at intake. Getting the gate wrong here is not a bug in one
  firm's data — it is one firm silently editing every other firm's forms, which
  is exactly what `PUT /cases/:caseId/forms/:formCode/pdf-mappings` did with
  nothing but `cases:update` behind it.

  ─── Why these are file assertions and not request tests ────────────────────

  There is no HTTP harness in this suite, and standing one up to prove a
  middleware is mounted would test the harness. What actually goes wrong is
  structural and visible in the source: a gate that stops being mounted, a
  tenant connection opened for a request that must not have one, a route that
  drifts back onto the firm's router. Each of those is one edit away and none
  of them fails anything else.

  The runtime behaviour is covered from the other direction: `rls-coverage`
  proves the tables are policied, and `authorization-coverage` proves the
  module is gated at all.
*/

const root = join(__dirname, "..", "..", "..");
const read = (...parts: string[]) =>
  readFileSync(join(root, "src", ...parts), "utf8");

describe("the platform tier is gated at the router, not per route", () => {
  const routes = read("modules", "platform", "platform.routes.ts");

  it("mounts requireAuth and requirePlatformAdmin on the whole router", () => {
    expect(routes).toContain("this.router.use(requireAuth);");
    expect(routes).toContain("this.router.use(requirePlatformAdmin);");
  });

  /*
    A mounted gate covers routes added later; a per-route one covers only the
    routes somebody remembered. Five mutating `/cases` endpoints once shipped
    ungated beside gated reads for precisely this reason, so the mount must
    come before the first route rather than merely be present.
  */
  it("mounts the gate before the first route it protects", () => {
    const gate = routes.indexOf("requirePlatformAdmin);");
    const firstRoute = routes.search(/this\.router\.(get|post|put|patch|delete)\(/);

    expect(gate).toBeGreaterThan(-1);
    expect(firstRoute).toBeGreaterThan(gate);
  });

  /*
    Nothing here is addressed by matter, and that is the whole boundary.

    A `:caseId` on this router would mean somebody had reintroduced the shape
    that made a global change look like a local one — the old routes all took a
    case id and none of them used it to scope the write.
  */
  it("addresses forms by code, never by matter", () => {
    // The route registrations, not the file: the docblock names the old
    // `/cases/:caseId/...` paths to explain why they moved, and a test that
    // could not tell a path from a sentence about one would fail on the
    // explanation.
    const paths = routes.match(/this\.router\.\w+\(\s*\n?\s*"([^"]+)"/g) ?? [];

    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.includes(":caseId"))).toEqual([]);
  });
});

describe("a platform request opens no tenant connection", () => {
  /*
    The load-bearing skip.

    A tenant connection sets `app.current_org_id`, and every platform-catalogue
    policy compares `organization_id = current_org_id`. Under a tenant
    connection those rows carry NULL on one side of that comparison, so the
    write is denied — which is correct, and which is why the CRM must not get
    one. Remove this condition and every write in the tier fails with an RLS
    error that reads like a bug in the query.
  */
  it("skips initializeTenantContext for a platform admin", () => {
    const auth = read("middleware", "auth.middleware.ts");

    expect(auth).toContain('accountType === "platform_admin"');
    expect(auth).toContain("if (!isPlatformAdmin && (organizationId || userId))");
  });

  /** The inverse guard: no organization is resolved for one either. */
  it("resolves a platform admin to no organization", () => {
    const actor = read("middleware", "resolve-actor-context.ts");

    expect(actor).toContain('platform_admin: "platform"');
    expect(actor).toContain("organizationId: null");
  });

  /**
   * Membership is the whole check, and it reads the system connection because
   * `platform_admins` has no tenant column for a scoped one to filter by.
   */
  it("checks membership against systemDb", () => {
    const guard = read("middleware", "require-platform-admin.ts");

    expect(guard).toContain("systemDb");
    expect(guard).toContain("platformAdmins.userId");
  });

  /**
   * The refusal is deliberately indistinguishable from "no such thing".
   *
   * A firm user probing this tier should not be able to tell a tier they
   * cannot reach from one that does not exist.
   */
  it("refuses without saying what the caller is missing", () => {
    const guard = read("middleware", "require-platform-admin.ts");

    // Every message the guard can throw, taken from the throws themselves —
    // the file also *discusses* the rejected wording in a comment, and matching
    // on the file would fail on the explanation of the choice.
    const thrown = [...guard.matchAll(/AuthorizationError\("([^"]+)"\)/g)].map(
      (match) => match[1],
    );

    expect(thrown).toContain("Not found");
    expect(thrown.join(" ")).not.toMatch(/platform admin/i);
  });
});

describe("the catalogue is out of reach of the firm's routers", () => {
  const workflow = read("modules", "workflow", "workflow.routes.ts");

  /*
    The specific hole this whole tier closed.

    `form_pdf_field_mappings` is RLS-exempt — it has no tenant column, because
    a box on a blank belongs to no firm — and this route wrote it behind
    `cases:update`. Any firm staffer could repoint an I-485 box for every firm
    in the deployment.
  */
  it("no longer lets a firm write PDF box mappings", () => {
    expect(workflow).not.toContain("pdf-mappings");
  });

  it("no longer lets a firm write field sources", () => {
    // The read at `/cases/:caseId/field-map` survives and is a GET; what must
    // not come back is a PUT or a DELETE on the same path.
    expect(workflow).not.toMatch(/router\.(put|delete)\(\s*\n?\s*"[^"]*field-map/);
  });

  it("no longer exposes the form-catalogue writes", () => {
    expect(workflow).not.toContain("form-catalogue");
  });

  /*
    What a firm may still do: put a *published* form on a matter. That is a
    decision about the matter, not about the form, and the code has to be one
    Oravanti publishes — an unknown one is a 404 rather than an invitation to
    name it.
  */
  it("lets a firm add a published form to a matter", () => {
    expect(workflow).toContain('"/:caseId/forms/:formCode"');
    expect(workflow).toContain('"/published-forms"');
  });
});

describe("the filing package is the platform's alone", () => {
  /*
    `case_type_forms` decides what every firm's next matter of a given type is
    provisioned with. One row puts an I-864 on every adjustment in the
    deployment, which is the same blast radius as a PDF box mapping and belongs
    behind the same gate.

    It is also the newest surface here, which is exactly when a route lands on
    the wrong router.
  */
  it("keeps the package writes on the platform router", () => {
    const platform = read("modules", "platform", "platform.routes.ts");
    const workflow = read("modules", "workflow", "workflow.routes.ts");

    expect(platform).toContain('"/case-types/:caseTypeId/forms"');
    expect(platform).toContain('"/case-types/:caseTypeId/forms/:formCode"');

    // The firm's router addresses forms by matter, never by case type. A
    // `case-types` path here would be a global write behind `cases:update`.
    expect(workflow).not.toContain("case-types");
  });

  /*
    The packages used to be two constants picked by an inferred boolean, and
    the inference is the part worth pinning gone: while it existed, "which
    forms does this file" had two answers — the constant and whatever the CRM
    showed — and nothing made them agree.
  */
  it("reads the package rather than holding one", () => {
    const service = read("modules", "workflow", "case-forms.service.ts");

    expect(service).not.toMatch(/const ADJUSTMENT_PACKAGEs*[:=]/);
    expect(service).not.toMatch(/const NATURALIZATION_PACKAGEs*[:=]/);
    expect(service).toContain("caseTypeForms.caseTypeId");
  });

  /** No tenant column, so no firm's rows and no firm's edits. */
  it("has no organization column to scope a firm's own package by", () => {
    const schema = read("db", "schema", "case-type-forms.ts");

    expect(schema).not.toMatch(/organizationId:/);
    expect(schema).toContain("case_type_forms_case_type_form_unique");
  });
});

describe("archiving a taxonomy node actually stops it being offered", () => {
  /*
    The point of the whole `status` column.

    Archiving is what an operator means by "stop offering this" — deleting is
    refused by the database once a matter exists, and would silently cascade
    away a firm's workflow templates and staff assignments when one does not.
    So the CMS writes `archived` and the *firm-facing* reads have to honour it.

    Nothing else fails if they stop: the column keeps its value, the CRM keeps
    showing the badge, and an archived case type quietly stays in every firm's
    picker. That is why this is asserted here rather than left to types.
  */
  const service = read("modules", "practice-areas", "practice-areas.service.ts");

  it("filters archived nodes out of every firm-facing taxonomy read", () => {
    expect(service).toContain('ne(status, "archived")');

    // One helper, applied at all three levels. Counting the call sites is what
    // catches a fourth query being added without it.
    const applied = service.match(/isOffered\(/g) ?? [];
    expect(applied.length).toBeGreaterThanOrEqual(6);
  });

  /*
    An enum rather than a boolean, at the user's instruction: two states is
    what a boolean can express and the third ("coming soon", "deprecated") is
    foreseeable. Pinned because reverting it is a one-line schema edit that
    nothing else would notice.
  */
  it("stores the state as an enum with room to grow", () => {
    const schema = read("db", "schema", "taxonomy-status.ts");

    expect(schema).toContain('pgEnum("taxonomy_status"');
    expect(schema).toContain('"archived"');

    /*
      The union is derived from `enumValues`, not written out beside it. That
      is what makes adding a third state one edit rather than two that can
      disagree — and a hand-written union is exactly what somebody reaches for
      when adding one in a hurry.
    */
    expect(schema).toContain("(typeof taxonomyStatusEnum.enumValues)[number]");
  });

  /*
    Deleting is refused with the list of what holds the node, rather than being
    allowed to cascade.

    The cascading half is the dangerous one and it produces no error at all:
    `firm_practice_areas`, `workflow_templates`, `staff_practice_area_case_types`
    and the rest all carry `onDelete: cascade`, so deleting one practice area
    would take every firm's configuration under it with no message anywhere.
  */
  it("counts what holds a node before deleting it", () => {
    const blockers = read("modules", "platform", "taxonomy-blockers.ts");
    const taxonomy = read("modules", "platform", "taxonomy.service.ts");

    expect(blockers).toContain("export function refuseIfBlocked");
    expect(blockers).toContain("ConflictError");

    for (const level of ["practiceArea", "subcategory", "caseType"]) {
      expect(blockers).toContain(`export async function ${level}Blockers`);
    }

    // One call per delete, so a fourth level cannot be added without one.
    const refusals = taxonomy.match(/refuseIfBlocked\(/g) ?? [];
    expect(refusals).toHaveLength(3);
  });

  /*
    `code` is settable at creation and never after: it is half of a unique key,
    the seeds find their targets by it, and a case type's `caseNumberPrefix` is
    already stamped into every matter number issued under it. The update bodies
    are `.strict()`, so an attempt to send one is a 400 rather than a silent
    no-op — which is only true while `code` stays off them.
  */
  it("keeps code off every update body", () => {
    const validation = read("modules", "platform", "platform.validation.ts");

    /** One schema's own declaration, from its name to its closing `.strict()`. */
    const declaration = (name: string) => {
      const start = validation.indexOf(`export const ${name}`);
      expect(start).toBeGreaterThan(-1);
      return validation.slice(start, validation.indexOf(".strict();", start));
    };

    for (const name of ["updateTaxonomyNodeBody", "updateCaseTypeBody"]) {
      expect(declaration(name)).not.toMatch(/\bcode\b/);
    }

    // And it is on the create bodies, which is where it is decided.
    expect(declaration("createSubcategoryBody")).toContain("code: nodeCode");
    expect(declaration("createCaseTypeBody")).toContain("code: nodeCode");
  });
});

describe("the questionnaire backbone is gated per route", () => {
  const routes = read("modules", "questionnaires", "questionnaires.routes.ts");

  /*
    The one place a per-route gate is right, because this router serves firm
    staff and clients on every other path. So every `/system` route needs the
    guard named on it, and a new one that forgets is the failure mode.

    Counted rather than spot-checked: the count is what catches a route added
    later without one.
  */
  it("guards every /system route", () => {
    /*
      Each registration is checked on its own rather than by counting guards
      against routes: a count passes just as happily when one route carries two
      guards and the next carries none.

      Split on the call rather than matched with one expression, because these
      are registered both ways — some on a single line, some across five — and
      an expression that spans to the closing paren silently swallows the
      registration after a single-line one.
    */
    const registrations = routes
      .split("this.router.")
      .slice(1)
      .filter((chunk) => /^\w+\(\s*\n?\s*"\/system/.test(chunk));

    // Eleven today — the tenth being `/system/field-vocabulary`, the platform's
    // door onto the list a question's `fieldKey` is chosen from. Pinned so that
    // a route added without a guard fails here rather than passing unexamined
    // because the split stopped seeing it.
    expect(registrations).toHaveLength(11);

    const ungated = registrations.filter(
      (chunk) => !chunk.slice(0, chunk.indexOf(");")).includes("requirePlatformAdmin"),
    );

    expect(ungated).toEqual([]);
  });
});

describe("a firm cannot reach the platform's own rows", () => {
  const service = read("modules", "questionnaires", "questionnaires.service.ts");

  /*
    Two `where` clauses, exact inverses, and between them every row is writable
    by exactly one tier.

    The firm's helpers match on its `organizationId`; the platform's match on
    the absence of one. Neither can reach the other's rows, which is the whole
    ownership rule expressed as queries rather than as a scope column somebody
    has to remember to check.
  */
  it("scopes firm writes by organization and platform writes by its absence", () => {
    expect(service).toContain("eq(questionnaireSections.organizationId, organizationId)");
    expect(service).toContain("isNull(questionnaireSections.organizationId)");
    expect(service).toContain("eq(questionnaireQuestions.organizationId, organizationId)");
    expect(service).toContain("isNull(questionnaireQuestions.organizationId)");
  });

  /*
    The copy-on-write path is gone, not disabled.

    A firm's edit of a platform row used to be stored as a copy pointing back at
    the original, which meant two rows claiming to be the same question and an
    answer that could not say which it was given to. `supersedeSection` and
    `supersedeQuestion` are deleted; an attempt to edit one of ours is a 404.
  */
  it("has no supersession path left", () => {
    // The functions, not the word: the file explains at length why the path is
    // gone, and a bare string match would fail on its own gravestone.
    expect(service).not.toMatch(/supersedeSection\s*=/);
    expect(service).not.toMatch(/supersedeQuestion\s*=/);
    expect(service).not.toMatch(/supersedesId:/);
  });

  it("tells a firm plainly when a row is not its own", () => {
    expect(service).toContain("Section not found, or it is one Oravanti maintains");
    expect(service).toContain("Question not found, or it is one Oravanti maintains");
  });
});

describe("form mappings are the platform's alone", () => {
  const mappings = read("modules", "workflow", "form-mappings.service.ts");

  /*
    A mapping is global, so a mapping pointing at one firm's question would
    leave the field unfed for every *other* firm while looking configured. The
    question list offers only the platform's, and the write refuses the rest.
  */
  it("offers only platform questions as a field source", () => {
    expect(mappings).toContain("isNull(questionnaireQuestions.organizationId)");
  });

  it("keeps no firm or case mapping scope", () => {
    expect(mappings).not.toMatch(/scope:\s*["']firm["']/);
    expect(mappings).not.toMatch(/scope:\s*["']case["']/);
  });
});
