import "dotenv/config";
import { App } from "./app";
import { AIErrorDetectionController } from "./resources/ai-error-detection/ai-error-detection.controller";
import { AIErrorDetectionRouter } from "./resources/ai-error-detection/ai-error-detection.routes";
import { AIErrorDetectionService } from "./resources/ai-error-detection/ai-error-detection.service";
import { AuthController } from "./resources/auth/auth.controller";
import { AuthRouter } from "./resources/auth/auth.routes";
import { AuthService } from "./resources/auth/auth.service";
import { CalendarController } from "./resources/calendar/calendar.controller";
import { CalendarRouter } from "./resources/calendar/calendar.routes";
import { CalendarService } from "./resources/calendar/calendar.service";
import { CasesController } from "./resources/cases/cases.controller";
import { CasesRouter } from "./resources/cases/cases.routes";
import { CasesService } from "./resources/cases/cases.service";
import { ClientResponsivenessController } from "./resources/client-responsiveness/client-responsiveness.controller";
import { ClientResponsivenessRouter } from "./resources/client-responsiveness/client-responsiveness.routes";
import { ClientResponsivenessService } from "./resources/client-responsiveness/client-responsiveness.service";
import { ClientsController } from "./resources/clients/clients.controller";
import { ClientsRouter } from "./resources/clients/clients.routes";
import { ClientsService } from "./resources/clients/clients.service";
import { DocumentsController } from "./resources/documents/documents.controller";
import { DocumentsRouter } from "./resources/documents/documents.routes";
import { DocumentsService } from "./resources/documents/documents.service";
import { AssignmentsController } from "./resources/hr-management/assignments/assignments.controller";
import { AssignmentsRouter } from "./resources/hr-management/assignments/assignments.routes";
import { AssignmentsService } from "./resources/hr-management/assignments/assignments.service";
import { StaffController } from "./resources/hr-management/staffs/staffs.controller";
import { StaffRouter } from "./resources/hr-management/staffs/staffs.routes";
import { StaffService } from "./resources/hr-management/staffs/staffs.service";
import { TeamsController } from "./resources/hr-management/teams/teams.controller";
import { TeamsRouter } from "./resources/hr-management/teams/teams.routes";
import { TeamsService } from "./resources/hr-management/teams/teams.service";
import { OrganizationController } from "./resources/organization/organization.controller";
import { OrganizationRouter } from "./resources/organization/organization.routes";
import { OrganizationService } from "./resources/organization/organization.service";
import { PracticeAreasController } from "./resources/practice-areas/practice-areas.controller";
import { PracticeAreasRouter } from "./resources/practice-areas/practice-areas.routes";
import { PracticeAreasService } from "./resources/practice-areas/practice-areas.service";
import { RevenueAnalyticsController } from "./resources/revenue-analytics/revenue-analytics.controller";
import { RevenueAnalyticsRouter } from "./resources/revenue-analytics/revenue-analytics.routes";
import { RevenueAnalyticsService } from "./resources/revenue-analytics/revenue-analytics.service";
import { AccessControlController } from "./resources/settings/access-control/access-control.controller";
import { AccessControlRouter } from "./resources/settings/access-control/access-control.routes";
import { AccessControlService } from "./resources/settings/access-control/access-control.service";
import { ApprovalWorkflowsController } from "./resources/settings/approval-workflows/approval-workflows.controller";
import { ApprovalWorkflowsRouter } from "./resources/settings/approval-workflows/approval-workflows.routes";
import { ApprovalWorkflowsService } from "./resources/settings/approval-workflows/approval-workflows.service";
import { CertificationGatesController } from "./resources/settings/certification-gates/certification-gates.controller";
import { CertificationGatesService } from "./resources/settings/certification-gates/certification-gates.service";
import { DataAccessController } from "./resources/settings/data-access/data-access.controller";
import { DataAccessRouter } from "./resources/settings/data-access/data-access.routes";
import { DataAccessService } from "./resources/settings/data-access/data-access.service";
import { FinancialAccessController } from "./resources/settings/financial-access/financial-access.controller";
import { FinancialAccessRouter } from "./resources/settings/financial-access/financial-access.routes";
import { FinancialAccessService } from "./resources/settings/financial-access/financial-access.service";
import { FirmInfoController } from "./resources/settings/firm-info/firm-info.controller";
import { FirmInfoRouter } from "./resources/settings/firm-info/firm-info.routes";
import { FirmInfoService } from "./resources/settings/firm-info/firm-info.service";
import { PermissionAuditLogController } from "./resources/settings/permission-audit-log/permission-audit-log.controller";
import { PermissionAuditLogRouter } from "./resources/settings/permission-audit-log/permission-audit-log.routes";
import { PermissionAuditLogService } from "./resources/settings/permission-audit-log/permission-audit-log.service";
import { ProfileController } from "./resources/settings/profile/profile.controller";
import { ProfileRouter } from "./resources/settings/profile/profile.routes";
import { ProfileService } from "./resources/settings/profile/profile.service";
import { SecurityController } from "./resources/settings/security/security.controller";
import { SecurityRouter } from "./resources/settings/security/security.routes";
import { SecurityService } from "./resources/settings/security/security.service";
import { TasksController } from "./resources/tasks/tasks.controller";
import { TasksRouter } from "./resources/tasks/tasks.routes";
import { TasksService } from "./resources/tasks/tasks.service";

const PORT = Number(process.env.PORT || 3000);

// Instantiate services and controllers for routers with dependency injection
const authService = new AuthService();
const authController = new AuthController(authService);
const authRouter = new AuthRouter(authController);

const staffService = new StaffService();
const staffController = new StaffController(staffService);
const staffRouter = new StaffRouter(staffController);

const teamsService = new TeamsService();
const teamsController = new TeamsController(teamsService);
const teamsRouter = new TeamsRouter(teamsController);

const assignmentsService = new AssignmentsService();
const assignmentsController = new AssignmentsController(assignmentsService);
const assignmentsRouter = new AssignmentsRouter(assignmentsController);

const documentsService = new DocumentsService();
const documentsController = new DocumentsController(documentsService);
const documentsRouter = new DocumentsRouter(documentsController);

const tasksService = new TasksService();
const tasksController = new TasksController(tasksService);
const tasksRouter = new TasksRouter(tasksController);

const aiErrorDetectionService = new AIErrorDetectionService();
const aiErrorDetectionController = new AIErrorDetectionController(
  aiErrorDetectionService,
);
const aiErrorDetectionRouter = new AIErrorDetectionRouter(
  aiErrorDetectionController,
);

const calendarService = new CalendarService();
const calendarController = new CalendarController(calendarService);
const calendarRouter = new CalendarRouter(calendarController);

const casesService = new CasesService();
const casesController = new CasesController(casesService);
const casesRouter = new CasesRouter(casesController);

const practiceAreasService = new PracticeAreasService();
const practiceAreasController = new PracticeAreasController(
  practiceAreasService,
);
const practiceAreasRouter = new PracticeAreasRouter(practiceAreasController);

const clientResponsivenessService = new ClientResponsivenessService();
const clientResponsivenessController = new ClientResponsivenessController(
  clientResponsivenessService,
);
const clientResponsivenessRouter = new ClientResponsivenessRouter(
  clientResponsivenessController,
);

const clientsService = new ClientsService();
const clientsController = new ClientsController(clientsService);
const clientsRouter = new ClientsRouter(clientsController);

const revenueAnalyticsService = new RevenueAnalyticsService();
const revenueAnalyticsController = new RevenueAnalyticsController(
  revenueAnalyticsService,
);
const revenueAnalyticsRouter = new RevenueAnalyticsRouter(
  revenueAnalyticsController,
);

const permissionAuditLogService = new PermissionAuditLogService();
const permissionAuditLogController = new PermissionAuditLogController(
  permissionAuditLogService,
);
const permissionAuditLogRouter = new PermissionAuditLogRouter(
  permissionAuditLogController,
);

const profileService = new ProfileService();
const profileController = new ProfileController(profileService);
const profileRouter = new ProfileRouter(profileController);

const firmInfoService = new FirmInfoService();
const firmInfoController = new FirmInfoController(firmInfoService);
const firmInfoRouter = new FirmInfoRouter(firmInfoController);

const accessControlService = new AccessControlService();
const accessControlController = new AccessControlController(
  accessControlService,
  permissionAuditLogService,
);

const certificationGatesService = new CertificationGatesService();
const certificationGatesController = new CertificationGatesController(
  certificationGatesService,
  permissionAuditLogService,
);
const accessControlRouter = new AccessControlRouter(
  accessControlController,
  certificationGatesController,
);

const financialAccessService = new FinancialAccessService();
const financialAccessController = new FinancialAccessController(
  financialAccessService,
  permissionAuditLogService,
);
const financialAccessRouter = new FinancialAccessRouter(
  financialAccessController,
);

const approvalWorkflowsService = new ApprovalWorkflowsService();
const approvalWorkflowsController = new ApprovalWorkflowsController(
  approvalWorkflowsService,
  permissionAuditLogService,
);
const approvalWorkflowsRouter = new ApprovalWorkflowsRouter(
  approvalWorkflowsController,
);

const dataAccessService = new DataAccessService();
const dataAccessController = new DataAccessController(
  dataAccessService,
  permissionAuditLogService,
);
const dataAccessRouter = new DataAccessRouter(dataAccessController);

const securityService = new SecurityService();
const securityController = new SecurityController(securityService);
const securityRouter = new SecurityRouter(securityController);

const organizationService = new OrganizationService();
const organizationController = new OrganizationController(organizationService);
const organizationRouter = new OrganizationRouter(organizationController);

const app = new App(
  [
    authRouter,
    staffRouter,
    teamsRouter,
    assignmentsRouter,
    documentsRouter,
    tasksRouter,
    aiErrorDetectionRouter,
    calendarRouter,
    casesRouter,
    practiceAreasRouter,
    clientResponsivenessRouter,
    clientsRouter,
    revenueAnalyticsRouter,
    permissionAuditLogRouter,
    profileRouter,
    firmInfoRouter,
    accessControlRouter,
    financialAccessRouter,
    approvalWorkflowsRouter,
    dataAccessRouter,
    securityRouter,
    organizationRouter,
  ],
  PORT,
);

app.listen().catch((error) => {
  console.error("Failed to start app:", error);
  process.exit(1);
});
