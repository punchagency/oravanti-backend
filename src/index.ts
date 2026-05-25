import 'dotenv/config';
import express from 'express';
import authRoutes from './routes/auth.routes';
import staffRoutes from './routes/hr/staff.routes';
import teamsRoutes from './routes/hr/teams.routes';
import assignmentsRoutes from './routes/hr/assignments.routes';
import profileRoutes from './routes/settings/profile.routes';
import firmInfoRoutes from './routes/settings/firm-info.routes';
import accessControlRoutes from './routes/settings/access-control.routes';
import financialAccessRoutes from './routes/settings/financial-access.routes';
import approvalWorkflowsRoutes from './routes/settings/approval-workflows.routes';
import permissionAuditLogRoutes from './routes/settings/permission-audit-log.routes';
import dataAccessRoutes from './routes/settings/data-access.routes';
import securityRoutes from './routes/settings/security.routes';
import clientsRoutes from './routes/clients/clients.routes';
import casesRoutes from './routes/cases/cases.routes';
import tasksRoutes from './routes/tasks/tasks.routes';
import clientResponsivenessRoutes from './routes/client-responsiveness/client-responsiveness.routes';
import revenueAnalyticsRoutes from './routes/revenue-analytics/revenue-analytics.routes';
import documentsRoutes from './routes/documents/documents.routes';
import aiErrorDetectionRoutes from './routes/ai-error-detection/ai-error-detection.routes';
import calendarRoutes from './routes/calendar/calendar.routes';

const app = express();
const PORT = process.env.PORT || 8001;

app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/hr/staff', staffRoutes);
app.use('/api/hr/teams', teamsRoutes);
app.use('/api/hr/assignments', assignmentsRoutes);
app.use('/api/settings/profile', profileRoutes);
app.use('/api/settings/firm-info', firmInfoRoutes);
app.use('/api/settings/access-control', accessControlRoutes);
app.use('/api/settings/financial-access', financialAccessRoutes);
app.use('/api/settings/approval-workflows', approvalWorkflowsRoutes);
app.use('/api/settings/permission-audit-log', permissionAuditLogRoutes);
app.use('/api/settings/data-access', dataAccessRoutes);
app.use('/api/settings/security', securityRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/cases', casesRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/client-responsiveness', clientResponsivenessRoutes);
app.use('/api/revenue-analytics', revenueAnalyticsRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/ai-error-detection', aiErrorDetectionRoutes);
app.use('/api/calendar', calendarRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
