import { relations } from "drizzle-orm";
import {
  account,
  invitation,
  member,
  organization,
  session,
  team,
  teamMember,
  twoFactor,
  user,
} from "./auth-schema";
import { practiceAreas } from "./practice-areas";
import { practiceAreaSubcategories } from "./practice-area-subcategories";
import { practiceAreaCaseTypes } from "./practice-area-case-types";
import { staff } from "./staff";
import { staffPracticeAreaCaseTypes } from "./staff-practice-area-case-types";
import { teamPracticeAreaCaseTypes } from "./team-practice-area-case-types";

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  teamMembers: many(teamMember),
  members: many(member),
  invitations: many(invitation),
  twoFactors: many(twoFactor),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  teams: many(team),
  members: many(member),
  invitations: many(invitation),
}));

export const teamRelations = relations(team, ({ one, many }) => ({
  organization: one(organization, {
    fields: [team.organizationId],
    references: [organization.id],
  }),
  teamMembers: many(teamMember),
  caseTypes: many(teamPracticeAreaCaseTypes),
}));

export const teamMemberRelations = relations(teamMember, ({ one }) => ({
  team: one(team, {
    fields: [teamMember.teamId],
    references: [team.id],
  }),
  user: one(user, {
    fields: [teamMember.userId],
    references: [user.id],
  }),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
  user: one(user, {
    fields: [twoFactor.userId],
    references: [user.id],
  }),
}));

export const practiceAreasRelations = relations(practiceAreas, ({ many }) => ({
  subcategories: many(practiceAreaSubcategories),
}));

export const practiceAreaSubcategoriesRelations = relations(
  practiceAreaSubcategories,
  ({ one, many }) => ({
    practiceArea: one(practiceAreas, {
      fields: [practiceAreaSubcategories.practiceAreaId],
      references: [practiceAreas.id],
    }),
    caseTypes: many(practiceAreaCaseTypes),
  }),
);

export const practiceAreaCaseTypesRelations = relations(
  practiceAreaCaseTypes,
  ({ one, many }) => ({
    subcategory: one(practiceAreaSubcategories, {
      fields: [practiceAreaCaseTypes.subcategoryId],
      references: [practiceAreaSubcategories.id],
    }),
    staffPracticeAreaCaseTypes: many(staffPracticeAreaCaseTypes),
    teamPracticeAreaCaseTypes: many(teamPracticeAreaCaseTypes),
  }),
);

export const staffRelations = relations(staff, ({ many }) => ({
  caseTypes: many(staffPracticeAreaCaseTypes),
}));

export const staffPracticeAreaCaseTypesRelations = relations(
  staffPracticeAreaCaseTypes,
  ({ one }) => ({
    staff: one(staff, {
      fields: [staffPracticeAreaCaseTypes.staffId],
      references: [staff.id],
    }),
    caseType: one(practiceAreaCaseTypes, {
      fields: [staffPracticeAreaCaseTypes.caseTypeId],
      references: [practiceAreaCaseTypes.id],
    }),
  }),
);

export const teamPracticeAreaCaseTypesRelations = relations(
  teamPracticeAreaCaseTypes,
  ({ one }) => ({
    team: one(team, {
      fields: [teamPracticeAreaCaseTypes.teamId],
      references: [team.id],
    }),
    caseType: one(practiceAreaCaseTypes, {
      fields: [teamPracticeAreaCaseTypes.caseTypeId],
      references: [practiceAreaCaseTypes.id],
    }),
  }),
);
