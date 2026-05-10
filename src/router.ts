/**
 * Root /api/v1 router.
 * Add sub-routers here as modules are implemented in later phases.
 */

import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

import { authRouter } from './modules/auth/auth.routes.js';
import { employeesRouter } from './modules/employees/employees.routes.js';
import { leaveRouter } from './modules/leave/leave.routes.js';
import { attendanceRouter } from './modules/attendance/attendance.routes.js';
import { regularisationsRouter } from './modules/attendance/regularisations.routes.js';
import { holidaysRouter } from './modules/attendance/holidays.routes.js';
import { payrollRouter, payslipsRouter, taxConfigRouter } from './modules/payroll/payroll.routes.js';
import { openApiSpec } from './lib/openapi.js';

const v1Router = Router();

// Health endpoint (no auth required)
v1Router.get('/health', (_req, res) => {
  res.status(200).json({
    data: {
      status: 'ok',
      uptime: process.uptime(),
      version: process.env['npm_package_version'] ?? '0.1.0',
    },
  });
});

// OpenAPI 3.1 spec — served as JSON for tooling (Postman, codegen, etc.)
v1Router.get('/openapi.json', (_req, res) => {
  res.status(200).json(openApiSpec);
});

// Swagger UI — interactive docs at /api/v1/docs
v1Router.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'Nexora HRMS API — docs',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      defaultModelsExpandDepth: 0,
    },
  }),
);

// Auth module (Phase 0)
v1Router.use('/auth', authRouter);

// Phase 1 — Employees & Hierarchy
v1Router.use('/employees', employeesRouter);

// Phase 2 — Leave Management
v1Router.use('/leave', leaveRouter);

// Phase 3 — Attendance, Regularisation, Holiday Calendar
v1Router.use('/attendance', attendanceRouter);
v1Router.use('/regularisations', regularisationsRouter);
v1Router.use('/config/holidays', holidaysRouter);

// Phase 4 — Payroll Processing
v1Router.use('/payroll', payrollRouter);
v1Router.use('/payslips', payslipsRouter);
v1Router.use('/config/tax', taxConfigRouter);

// Phase 5+ modules will be mounted here:
// v1Router.use('/performance', performanceRouter);
// v1Router.use('/notifications', notificationsRouter);
// v1Router.use('/audit', auditRouter);

export { v1Router };
