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
    clients: ["read"],
    staffs: ["read"],
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
    clients: [],
    staffs: ["read"],
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
    clients: [],
    staffs: [],
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
    clients: ["read"],
    staffs: [],
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
  clients: [],
  staffs: [],
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

export const owner = ac.newRole({
  dashboard: ["read"],
  leads: ["create", "read", "update", "delete"],
  clients: ["read", "create", "update", "delete"],
  cases: ["read", "create", "update", "delete", "view_assigned"],
  staffs: ["read", "create", "update", "delete", "view_performance"],
  invitations: ["read", "create", "update", "delete"],
  portal: ["update"],
  conflicts: ["review"],
  documents: ["read", "download", "create", "update", "delete"],
  case_review: ["read", "resolve", "configure"],
  calendar: ["read", "create", "update", "delete"],
  ai_review: ["read", "resolve", "configure"],
  analytics: ["read"],
  firm_settings: ["read", "update"],
  email_accounts: ["read", "update", "connect", "disconnect"],
  add_ons: ["read", "activate", "deactivate"],
  integrations: ["read", "configure"],
  training: ["read", "configure"],
  audit: ["read", "export"],
  finance: [
    "read",
    "create",
    "update",
    "record_payment",
    "refund",
    "approve_time",
    "log_time",
    "trust",
    "configure",
    "record_consultation_fee",
  ],
  ...ownerAc.statements,
});

export const admin = ac.newRole({
  dashboard: ["read"],
  leads: ["create", "read", "update", "delete"],
  clients: ["read", "create", "update", "delete"],
  cases: ["read", "create", "update", "delete", "view_assigned"],
  staffs: ["read", "create", "update", "delete", "view_performance"],
  invitations: ["read", "create", "update", "delete"],
  portal: ["update"],
  conflicts: ["review"],
  documents: ["read", "download", "create", "update", "delete"],
  case_review: ["read", "resolve", "configure"],
  calendar: ["read", "create", "update", "delete"],
  ai_review: ["read", "resolve", "configure"],
  analytics: ["read"],
  firm_settings: ["read", "update"],
  email_accounts: ["read", "update", "connect", "disconnect"],
  add_ons: ["read", "activate", "deactivate"],
  integrations: ["read", "configure"],
  training: ["read", "configure"],
  audit: ["read", "export"],
  finance: [
    "read",
    "create",
    "update",
    "record_payment",
    "refund",
    "approve_time",
    "log_time",
    "trust",
    "configure",
    "record_consultation_fee",
  ],
  ...adminAc.statements,
});

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
