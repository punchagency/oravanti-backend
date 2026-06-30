import { AIErrorDetectionModule } from "./ai-error-detection/ai-error-detection.module";
import { AuthModule } from "./auth/auth.module";
import { CalendarModule } from "./calendar/calendar.module";
import { CasesModule } from "./cases/cases.module";
import { ClientResponsivenessModule } from "./client-responsiveness/client-responsiveness.module";
import { ClientsModule } from "./clients/clients.module";
import { DocumentsModule } from "./documents/documents.module";
import { EmailAccountModule } from "./email-account/email-account.module";
import { AssignmentsModule } from "./hr-management/assignments/assignments.module";
import { StaffModule } from "./hr-management/staffs/staffs.module";
import { TeamsModule } from "./hr-management/teams/teams.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { OrganizationModule } from "./organization/organization.module";
import { PracticeAreasModule } from "./practice-areas/practice-areas.module";
import { QuestionnairesModule } from "./questionnaires/questionnaires.module";
import { RevenueAnalyticsModule } from "./revenue-analytics/revenue-analytics.module";
import { AccessControlModule } from "./settings/access-control/access-control.module";
import { ApprovalWorkflowsModule } from "./settings/approval-workflows/approval-workflows.module";
import { ConsultationSettingsModule } from "./settings/consultation/consultation-settings.module";
import { DataAccessModule } from "./settings/data-access/data-access.module";
import { FinancialAccessModule } from "./settings/financial-access/financial-access.module";
import { FirmInfoModule } from "./settings/firm-info/firm-info.module";
import { PermissionAuditLogModule } from "./settings/permission-audit-log/permission-audit-log.module";
import { ProfileModule } from "./settings/profile/profile.module";
import { SecurityModule } from "./settings/security/security.module";
import { StaffAvailabilityModule } from "./staff-availability/staff-availability.module";
import { TasksModule } from "./tasks/tasks.module";
import {
  AgreementsModule,
  ConsultationBookingModule,
  LeadsModule,
  WebhooksModule,
} from "./leads/leads.module";
import type { Module } from "../app";

export const modules: Module[] = [
  new AuthModule(),
  new StaffModule(),
  new StaffAvailabilityModule(),
  new TeamsModule(),
  new AssignmentsModule(),
  new DocumentsModule(),
  new EmailAccountModule(),
  new QuestionnairesModule(),
  new TasksModule(),
  new AIErrorDetectionModule(),
  new CalendarModule(),
  new CasesModule(),
  new PracticeAreasModule(),
  new ClientResponsivenessModule(),
  new ClientsModule(),
  new RevenueAnalyticsModule(),
  new PermissionAuditLogModule(),
  new ProfileModule(),
  new FirmInfoModule(),
  new ConsultationSettingsModule(),
  new AccessControlModule(),
  new FinancialAccessModule(),
  new ApprovalWorkflowsModule(),
  new DataAccessModule(),
  new SecurityModule(),
  new OrganizationModule(),
  new OnboardingModule(),
  new LeadsModule(),
  new AgreementsModule(),
  new WebhooksModule(),
  new ConsultationBookingModule(),
];
