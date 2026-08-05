import { AuthModule } from "./auth/auth.module";
import { CalendarModule } from "./calendar/calendar.module";
import { CasesModule } from "./cases/cases.module";
import { ClientResponsivenessModule } from "./client-responsiveness/client-responsiveness.module";
import { ClientsModule } from "./clients/clients.module";
import { DocumentsModule } from "./documents/documents.module";
import { EmailAccountModule } from "./email-account/email-account.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { OrganizationModule } from "./organization/organization.module";
import { PracticeAreasModule } from "./practice-areas/practice-areas.module";
import { AiScanModule } from "./ai-scan/ai-scan.module";
import { CaseReviewModule } from "./case-review/case-review.module";
import { DocumentRequirementsModule } from "./document-requirements/document-requirements.module";
import { QuestionnairesModule } from "./questionnaires/questionnaires.module";
import {
  FinanceReportsModule,
  InvoicesModule,
  TimeBillingModule,
} from "./finance/finance.module";
import { RevenueAnalyticsModule } from "./revenue-analytics/revenue-analytics.module";
import { AccessControlModule } from "./settings/access-control/access-control.module";
import { ApprovalWorkflowsModule } from "./settings/approval-workflows/approval-workflows.module";
import { ConsultationSettingsModule } from "./settings/consultation/consultation-settings.module";
import { DataAccessModule } from "./settings/data-access/data-access.module";
import { FinancialAccessModule } from "./settings/financial-access/financial-access.module";
import { FirmInfoModule } from "./settings/firm-info/firm-info.module";
import { PermissionAuditLogModule } from "./settings/permission-audit-log/permission-audit-log.module";
import { SecurityModule } from "./settings/security/security.module";
import { StaffAvailabilityModule } from "./staff-availability/staff-availability.module";
import { StaffsModule } from "./staffs/staffs.module";
import { TasksModule } from "./tasks/tasks.module";
import { WorkflowModule } from "./workflow/workflow.module";
import {
  AgreementSigningModule,
  AgreementsModule,
  ConsultationBookingModule,
  LeadsModule,
  WebhooksModule,
} from "./leads/leads.module";
import type { Module } from "../app";

export const modules: Module[] = [
  new AuthModule(),
  new StaffsModule(),
  new StaffAvailabilityModule(),
  new DocumentsModule(),
  new EmailAccountModule(),
  new QuestionnairesModule(),
  new AiScanModule(),
  new CaseReviewModule(),
  new DocumentRequirementsModule(),
  new TasksModule(),
  new WorkflowModule(),
  new CalendarModule(),
  new CasesModule(),
  new PracticeAreasModule(),
  new ClientResponsivenessModule(),
  new ClientsModule(),
  new RevenueAnalyticsModule(),
  new InvoicesModule(),
  new TimeBillingModule(),
  new FinanceReportsModule(),
  new PermissionAuditLogModule(),
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
  new AgreementSigningModule(),
  new ConsultationBookingModule(),
];
