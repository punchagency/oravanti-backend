import "dotenv/config";
import { App } from "./app";
import { AIErrorDetectionModule } from "./resources/ai-error-detection/ai-error-detection.module";
import { AuthModule } from "./resources/auth/auth.module";
import { CalendarModule } from "./resources/calendar/calendar.module";
import { CasesModule } from "./resources/cases/cases.module";
import { ClientResponsivenessModule } from "./resources/client-responsiveness/client-responsiveness.module";
import { ClientsModule } from "./resources/clients/clients.module";
import { DocumentsModule } from "./resources/documents/documents.module";
import { AssignmentsModule } from "./resources/hr-management/assignments/assignments.module";
import { StaffModule } from "./resources/hr-management/staffs/staffs.module";
import { TeamsModule } from "./resources/hr-management/teams/teams.module";
import { OnboardingModule } from "./resources/onboarding/onboarding.module";
import { OrganizationModule } from "./resources/organization/organization.module";
import { PracticeAreasModule } from "./resources/practice-areas/practice-areas.module";
import { QuestionnairesModule } from "./resources/questionnaires/questionnaires.module";
import { RevenueAnalyticsModule } from "./resources/revenue-analytics/revenue-analytics.module";
import { AccessControlModule } from "./resources/settings/access-control/access-control.module";
import { ApprovalWorkflowsModule } from "./resources/settings/approval-workflows/approval-workflows.module";
import { DataAccessModule } from "./resources/settings/data-access/data-access.module";
import { FinancialAccessModule } from "./resources/settings/financial-access/financial-access.module";
import { FirmInfoModule } from "./resources/settings/firm-info/firm-info.module";
import { PermissionAuditLogModule } from "./resources/settings/permission-audit-log/permission-audit-log.module";
import { ProfileModule } from "./resources/settings/profile/profile.module";
import { SecurityModule } from "./resources/settings/security/security.module";
import { TasksModule } from "./resources/tasks/tasks.module";

const PORT = Number(process.env.PORT || 3000);

const app = new App(
  [
    new AuthModule(),
    new StaffModule(),
    new TeamsModule(),
    new AssignmentsModule(),
    new DocumentsModule(),
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
    new AccessControlModule(),
    new FinancialAccessModule(),
    new ApprovalWorkflowsModule(),
    new DataAccessModule(),
    new SecurityModule(),
    new OrganizationModule(),
    new OnboardingModule(),
  ],
  PORT,
);

app.listen().catch((error) => {
  console.error("Failed to start app:", error);
  process.exit(1);
});
