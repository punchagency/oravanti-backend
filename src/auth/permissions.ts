import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

const statement = {
  // `...defaultStatements` already includes better-auth's own `ac` resource
  // (role management itself) — `ownerAc`/`adminAc` below already grant it
  // full CRUD by default, which is exactly "only owner/admin may create,
  // edit, or delete roles." Locked-default roles are additionally guarded
  // in the roles-permissions service, since attenuation alone only stops a
  // caller granting more than their own role holds, not narrowing their own.
  ...defaultStatements,
  // Dashboard: the main overview page. Gated so firms can restrict who sees
  // firm-wide metrics at a glance.
  dashboard: ["read"],
  // Leads (intake pipeline): first-contact through case opening.
  leads: ["create", "read", "update", "delete"],
  // `view_assigned` is a scoped variant of `read`, not a separate conditions
  // engine: a role can hold either, both, or neither alongside `read`
  // (unrestricted, firm-wide). Handlers that serve case lists/details check
  // the caller's grant and narrow the query accordingly. Clients are scoped
  // to their own case a different way — RLS user-ownership policies, not
  // this action — since clients never resolve an `organizationId` and are
  // gated through the static `clientPermissions` fallback below, not `ac`.
  cases: [
    "read",
    "create",
    "update",
    "delete",
    "view_assigned", // staff: only cases assigned to them, not the whole firm
  ],
  // Tasks: the unified work item — workflow steps materialized from a case's
  // template, intake-pipeline steps on a lead, and ad-hoc to-dos alike.
  //
  // Its own resource rather than riding on `cases`, because the two grants
  // answer different questions. `cases:update` is "may edit the matter
  // itself"; a paralegal holds only `cases:view_assigned` yet performs most of
  // the workflow steps on it, so gating task writes on `cases:update` would
  // lock the engine's primary user out of their own queue. Reading the
  // workflow *template* behind those tasks is `tasks:read` too — same surface,
  // one level up — while editing one is `firm_settings:update`, because a
  // template is firm configuration rather than case work.
  tasks: ["read", "create", "update", "delete"],
  // Workflow templates: the per-case-type blueprint a matter's tasks are
  // materialized from.
  //
  // Separate from `tasks` because the two are different objects at different
  // levels — a task is case work, a template is the firm's standard operating
  // procedure for a whole practice area, and editing one silently changes every
  // future matter of that type. It previously rode on `firm_settings:update`,
  // which conflated "may reshape the firm's workflows" with "may change the
  // firm's billing and compliance settings"; a firm that wants a senior
  // attorney curating templates had to hand over the whole settings surface.
  //
  //   read   — resolve the template behind a case, see which steps are locked
  //   update — clone the system default into the firm's own copy and edit it
  //
  // `update` covers cloning: a firm's first edit to a shared default clones it
  // rather than mutating the row every other firm reads, so the clone is not a
  // separate privilege, it is the mechanics of the first edit.
  workflow: ["read", "update"],
  clients: ["read", "create", "update", "delete"],
  staffs: ["read", "create", "update", "delete", "view_performance"],
  invitations: ["read", "create", "update", "delete"],
  // Staff portal access: enabling/disabling a staff member's client-portal
  // login (`PATCH /organization/staffs/:staffId/portal-status`). Kept
  // separate from `staffs:update` — which is editing staff records — so
  // widening who may edit a staff profile never silently widens who can
  // grant or revoke portal sign-in. Granted by default only to owner/admin.
  portal: ["update"],
  conflicts: ["review"], // conflict-check resolution (owners + admins only)
  documents: ["read", "download", "create", "update", "delete"], // download gates client docs
  case_review: ["read", "resolve", "configure"], // AI case review dashboard
  // Calendar: hearings, interviews, deadlines, appointments.
  calendar: ["read", "create", "update", "delete"],
  // AI review dashboard: document and case review workflows.
  ai_review: ["read", "resolve", "configure"],
  // Analytics dashboards: firm overview, revenue, staff performance, etc.
  analytics: ["read"],
  // Firm settings: general, billing, notifications, compliance, payments.
  firm_settings: ["read", "update"],
  // Email accounts: connecting and managing the firm's email integrations.
  email_accounts: ["read", "update", "connect", "disconnect"],
  // Add-on activation: toggling firm-level add-on features.
  add_ons: ["read", "activate", "deactivate"],
  // Integrations: configuring third-party integrations.
  integrations: ["read", "configure"],
  // Training platform: managing staff training and education modules.
  training: ["read", "configure"],
  // The firm-wide audit trail. Reading it means reading every action every
  // colleague has taken, so it is an owner/admin surface — the per-entity
  // activity feeds on a lead or a matter are gated by that entity instead.
  audit: ["read", "export"],
  // Finance: invoicing, payments, time & billing, reports.
  finance: [
    "read",
    "create",
    "update",
    "record_payment",
    // Sending money back to a client. Deliberately NOT covered by
    // `record_payment`: recording a payment wrongly is correctable from the
    // same screen, whereas a refund moves money out of the firm's account and
    // cannot be taken back. Granted to owner and admin only.
    "refund",
    "approve_time",
    "log_time",
    "trust",
    // Connecting the firm's payment processor: creating the merchant account,
    // completing underwriting, holding its credential. Kept separate from
    // `update` — which is invoice editing — so that widening who may edit an
    // invoice never silently widens who may bind the firm to a processor.
    "configure",
    // Recording an intake consultation fee, capped to the firm's preset
    // rate table — deliberately narrower than `create` (full invoice
    // authoring). The cap itself is enforced by the consultation-fee
    // handler, not by this grant; holding this action only proves the
    // caller may record a fee at all, not that any particular amount is
    // within range.
    "record_consultation_fee",
  ],
} as const;

export const ac = createAccessControl(statement);

/**
 * Every action of every resource — the grant Super admin and Admin hold.
 *
 * Derived from `statement` rather than hand-listed, because the hand-listed
 * version silently rotted: adding the `tasks` resource left `owner` and `admin`
 * without a `tasks` key at all, which meant the two roles that are supposed to
 * have full access were the only ones getting a 403 on every task route. A
 * resource added tomorrow is covered here the moment it is declared above.
 *
 * `defaultStatements` (better-auth's own `organization`/`member`/`invitation`/
 * `team`/`ac` resources) is spread into `statement`, so those appear here too —
 * but both roles below re-spread `ownerAc`/`adminAc` afterwards, which is what
 * preserves the one real difference between them: an admin cannot delete the
 * organization or transfer ownership.
 */
const FULL_ACCESS = Object.fromEntries(
  Object.entries(statement).map(([resource, actions]) => [resource, [...actions]]),
) as { [Resource in keyof typeof statement]: (typeof statement)[Resource][number][] };

// The four default roles a firm actually assigns day to day. Deliberately
// NOT registered in the org plugin's static `roles` map (see auth/index.ts)
// — a name in that map can never get a real `organizationRole` DB row of
// its own (better-auth's `createOrgRole`/`updateOrgRole` refuse a name
// already taken by a pre-defined role), which would make "edit this role's
// permissions" and "reset to default" impossible to implement for real.
// Instead these are seeded as ordinary DB rows per organization —
// `seedDefaultRoleRows` in `./seed-default-roles.ts` does this at firm
// creation and self-heals it for any org missing them — and from there they
// are edited, deleted-and-reset, and read through the exact same
// `auth.api.*Org Role`/`hasPermission` machinery as a firm's own custom
// roles. This map is their factory baseline: what a brand-new org is
// seeded with, and what "Reset to default" restores.
export const DEFAULT_ROLE_NAMES = [
  "attorney",
  "paralegal",
  "legal_assistant",
  "receptionist",
] as const;

export type DefaultRoleName = (typeof DEFAULT_ROLE_NAMES)[number];

export const DEFAULT_ROLE_PERMISSIONS: Record<DefaultRoleName, Record<string, readonly string[]>> = {
  // Full firm-wide case access, conflict-check authority, and fee-agreement
  // generation — the senior default role beneath firm admin.
  attorney: {
    dashboard: ["read"],
    leads: ["read", "update"],
    cases: ["read", "create", "update"],
    tasks: ["read", "create", "update", "delete"],
    // Reads the blueprint behind a matter and sees which steps are locked.
    // Editing a template changes every future matter of that type, so it
    // stays an owner/admin act.
    workflow: ["read"],
    clients: ["read"],
    staffs: ["read"],
    // Empty, not absent. Inviting a colleague into the firm is an owner/admin
    // act — but the key has to be here to say so, because an absent key is
    // indistinguishable from an oversight and is the one thing
    // `backfillDefaultRolePermissions` cannot fill in later.
    invitations: [],
    portal: [],
    conflicts: ["review"],
    documents: ["read", "download"],
    case_review: ["read", "resolve"],
    calendar: ["read"],
    ai_review: ["read"],
    analytics: ["read"],
    firm_settings: [],
    email_accounts: [],
    add_ons: [],
    integrations: [],
    training: [],
    audit: [],
    finance: ["read", "create", "log_time"],
    ...memberAc.statements,
  },
  // Assigned-cases only; certified workflow steps but never override/approve
  // a filing (case_review stays read-only). No conflict-check authority, no
  // money handling beyond logging their own time.
  paralegal: {
    dashboard: ["read"],
    leads: ["read"],
    cases: ["view_assigned"],
    // Creates and completes workflow steps on assigned matters; never deletes
    // one, which is how a locked compliance step would disappear.
    tasks: ["read", "create", "update"],
    // The paralegal works the steps, so they need to see what the template
    // says a matter of this type involves.
    workflow: ["read"],
    clients: [],
    staffs: ["read"],
    invitations: [],
    portal: [],
    conflicts: [],
    documents: ["read"],
    case_review: ["read"],
    calendar: ["read"],
    ai_review: ["read"],
    analytics: [],
    firm_settings: [],
    email_accounts: [],
    add_ons: [],
    integrations: [],
    training: [],
    audit: [],
    finance: ["read", "log_time"],
    ...memberAc.statements,
  },
  // Minimal, support-only access: reads what attorneys/paralegals are
  // working on, never opens a case or runs a conflict check.
  legal_assistant: {
    dashboard: ["read"],
    leads: ["read"],
    cases: ["view_assigned"],
    // Support-only: works the tasks it is assigned, never opens or removes one.
    tasks: ["read", "update"],
    workflow: ["read"],
    clients: [],
    staffs: [],
    invitations: [],
    portal: [],
    conflicts: [],
    documents: ["read"],
    case_review: [],
    calendar: ["read"],
    ai_review: [],
    analytics: [],
    firm_settings: [],
    email_accounts: [],
    add_ons: [],
    integrations: [],
    training: [],
    audit: [],
    finance: [],
    ...memberAc.statements,
  },
  // Intake-facing: search and basic scheduling, never modifies a case or
  // records a fee outside the firm's preset rate table.
  receptionist: {
    dashboard: ["read"],
    leads: ["read", "create"],
    cases: ["read"],
    // Sees what is outstanding to answer the phone with; changes none of it.
    tasks: ["read"],
    // Reads the outstanding work to answer the phone with; has no reason to
    // read the firm's standard operating procedure.
    workflow: [],
    clients: ["read"],
    staffs: [],
    invitations: [],
    portal: [],
    conflicts: [],
    documents: [],
    case_review: [],
    calendar: ["read"],
    ai_review: [],
    analytics: [],
    firm_settings: [],
    email_accounts: [],
    add_ons: [],
    integrations: [],
    training: [],
    audit: [],
    finance: ["record_consultation_fee"],
    ...memberAc.statements,
  },
};

// Not used for gating — `requireAuth` never resolves an `organizationId`
// for account type "client", so `requirePermission` always falls through to
// the static `clientPermissions` object below for them, never `hasPermission`.
// This role exists only because `clients.service.ts` calls
// `auth.api.addMember({ role: "client", ... })` so a client shows up in the
// organization's own member bookkeeping (teams, member lists) — better-auth
// rejects an unregistered role name there, so this must stay wired into the
// plugin's `roles` map even though it grants nothing meaningful.
export const client = ac.newRole({
  dashboard: [],
  leads: [],
  cases: [],
  tasks: [],
  workflow: [],
  clients: [],
  staffs: [],
  invitations: [],
  portal: [],
  conflicts: [],
  documents: [],
  case_review: [],
  calendar: [],
  ai_review: [],
  analytics: [],
  firm_settings: [],
  email_accounts: [],
  add_ons: [],
  integrations: [],
  training: [],
  audit: [],
  finance: [],
  ...memberAc.statements,
});

/** Super admin. Full access to everything, plus better-auth's owner-only org operations. */
export const owner = ac.newRole({ ...FULL_ACCESS, ...ownerAc.statements });

/**
 * Admin. The same full application access as Super admin — the difference is
 * `adminAc` rather than `ownerAc`, i.e. an admin cannot delete the organization
 * or transfer ownership.
 */
export const admin = ac.newRole({ ...FULL_ACCESS, ...adminAc.statements });

// Display metadata for the default roster. better-auth roles carry no label
// of their own; `locked` roles cannot be edited or deleted (enforced in the
// roles-permissions service, not by better-auth — attenuation stops a role
// being widened beyond the caller's own grant, but not narrowed below it).
export const ROLE_METADATA: Record<
  string,
  { label: string; description: string; locked: boolean }
> = {
  owner: {
    label: "Super admin",
    description: "Full platform access. Manages firm settings, staff, billing, and all modules.",
    locked: true,
  },
  admin: {
    label: "Admin",
    description: "Full operational access — cases, staff, settings, and billing. Cannot transfer ownership or delete the firm.",
    locked: false,
  },
  attorney: {
    label: "Attorney",
    description: "Full case access, conflict check authority, fee agreement generation, and case opening.",
    locked: false,
  },
  paralegal: {
    label: "Paralegal",
    description: "Assigned cases only. Can complete certified workflow steps. Cannot override or approve filings.",
    locked: false,
  },
  legal_assistant: {
    label: "Legal assistant",
    description: "Minimal access. Supports attorneys and paralegals. Cannot open cases or run conflict checks.",
    locked: false,
  },
  receptionist: {
    label: "Receptionist",
    description: "Handles initial intake, scheduling, and basic search only. Cannot modify cases or settings.",
    locked: false,
  },
};

// A starting-point swatch offered in the role color picker — not a closed
// set. The picker also accepts a native color-wheel pick or a pasted hex
// code, so the color is stored as a plain hex string and validated only as
// well-formed (`isValidRoleColor`), not membership in this list.
export const ROLE_COLOR_PRESETS = [
  "#6B7280", // gray
  "#EF4444", // red
  "#F97316", // orange
  "#EAB308", // yellow
  "#22C55E", // green
  "#14B8A6", // teal
  "#3B82F6", // blue
  "#06B6D4", // cyan
  "#A855F7", // purple
  "#EC4899", // pink
] as const;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidRoleColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

// ── Client & Contractor permission sets ──────────────────────────────────────
// These are static permission sets for non-staff user types.
// They don't use organization-based RBAC — access is controlled by RLS policies
// (user-ownership checks at the database level).

export const clientPermissions: Record<string, string[]> = {
  cases: ["read"],
  clients: ["read"],
  documents: ["read", "download"],
};

export const contractorPermissions: Record<string, string[]> = {
  cases: ["read"],
  clients: [],
  documents: ["read", "download"],
  staffs: [],
};

export type ClientPermissions = typeof clientPermissions;
export type ContractorPermissions = typeof contractorPermissions;

// Only three roles are still statically defined in code: `owner` (the
// locked firm-admin role — always full access, never editable), `admin` (a
// thin technical alias for better-auth's own owner/admin distinction —
// delete-org, transfer-ownership — never a selectable staff role in the UI),
// and `client` (kept wired only for `addMember` bookkeeping, see its own
// comment above; grants nothing meaningful and is never actually consulted
// for gating). Every other assignable role — the four DB-seeded defaults
// (`DEFAULT_ROLE_PERMISSIONS`) and any firm-created custom role — lives
// entirely in the `organizationRole` table and is resolved from there.
const ALL_STATIC_ROLES: Record<string, { statements: Record<string, readonly string[]> }> = {
  owner,
  admin,
  client,
};

/**
 * The `resource:action` grants a set of role names carries, considering only
 * the three statically-defined roles (owner/admin/client — see
 * `ALL_STATIC_ROLES`). Every other role name — including the four default
 * roles — is DB-backed and must be resolved by reading `organizationRole`,
 * which this function deliberately does not do: it needs no request headers
 * or DB access, which is what lets `customSession` call it without either.
 * `RolesPermissionsService.getMyGrants` (and the `customSession` callback)
 * layer the DB-role lookup on top of this for every name it doesn't cover.
 */
export function resolveStaticGrants(roleNames: string[]): string[] {
  const grants = new Set<string>();
  for (const roleName of roleNames) {
    const role = ALL_STATIC_ROLES[roleName];
    if (!role) continue;
    for (const [resource, actions] of Object.entries(role.statements)) {
      for (const action of actions) grants.add(`${resource}:${action}`);
    }
  }
  return Array.from(grants);
}
