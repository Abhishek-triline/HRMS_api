/**
 * OpenAPI 3.1 spec generated from the zod schemas in @nexora/contracts.
 *
 * The contract package stays pure (no OpenAPI dep). This file:
 *   1. Extends zod with `.openapi()` once, locally.
 *   2. Registers every contract schema as a named component.
 *   3. Registers every endpoint as a typed path with request + response shapes.
 *   4. Generates the spec via OpenApiGeneratorV31.
 *
 * Re-run automatically every time the API boots — no codegen step.
 *
 * Add a new module: import its schemas at the top, call `registry.register(...)`
 * for the body / response shapes, then call `registry.registerPath(...)` for
 * each endpoint.
 */

import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import {
  AuthMeResponseSchema,
  AuthUserSchema,
  ForgotPasswordRequestSchema,
  ForgotPasswordResponseSchema,
  FirstLoginSetPasswordRequestSchema,
  FirstLoginSetPasswordResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutResponseSchema,
  ResetPasswordRequestSchema,
  ResetPasswordResponseSchema,
} from '@nexora/contracts/auth';
import { ErrorEnvelopeSchema } from '@nexora/contracts/errors';
import {
  EmployeeStatusSchema,
  EmploymentTypeSchema,
  RoleSchema,
} from '@nexora/contracts/common';
import {
  CreateEmployeeRequestSchema,
  CreateEmployeeResponseSchema,
  EmployeeDetailSchema,
  EmployeeDetailResponseSchema,
  EmployeeListQuerySchema,
  EmployeeListResponseSchema,
  UpdateEmployeeRequestSchema,
  UpdateEmployeeResponseSchema,
  UpdateSalaryRequestSchema,
  UpdateSalaryResponseSchema,
  ChangeStatusRequestSchema,
  ChangeStatusResponseSchema,
  ReassignManagerRequestSchema,
  ReassignManagerResponseSchema,
  TeamResponseSchema,
  ProfileResponseSchema,
  SalaryStructureSchema,
} from '@nexora/contracts/employees';
import {
  LeaveTypeSchema,
  LeaveStatusSchema,
  RoutedToSchema,
  LeaveBalanceSchema,
  LeaveBalancesResponseSchema,
  LeaveTypeCatalogItemSchema,
  LeaveTypesResponseSchema,
  LeaveRequestSchema,
  LeaveRequestSummarySchema,
  CreateLeaveRequestSchema,
  CreateLeaveResponseSchema,
  LeaveListQuerySchema,
  LeaveListResponseSchema,
  LeaveRequestDetailResponseSchema,
  ApproveLeaveRequestSchema,
  ApproveLeaveResponseSchema,
  RejectLeaveRequestSchema,
  RejectLeaveResponseSchema,
  CancelLeaveRequestSchema,
  CancelLeaveResponseSchema,
  LeaveConflictDetailsSchema,
  AdjustBalanceRequestSchema,
  AdjustBalanceResponseSchema,
  UpdateLeaveTypeRequestSchema,
  UpdateLeaveQuotaRequestSchema,
} from '@nexora/contracts/leave';
import {
  AttendanceStatusSchema,
  AttendanceSourceSchema,
  AttendanceRecordSchema,
  AttendanceCalendarItemSchema,
  CheckInRequestSchema,
  CheckInResponseSchema,
  CheckOutRequestSchema,
  CheckOutResponseSchema,
  AttendanceListQuerySchema,
  AttendanceListResponseSchema,
  TodayAttendanceResponseSchema,
  RegStatusSchema,
  RegRoutedToSchema,
  RegularisationRequestSchema,
  RegularisationSummarySchema,
  CreateRegularisationRequestSchema,
  CreateRegularisationResponseSchema,
  RegularisationListQuerySchema,
  RegularisationListResponseSchema,
  RegularisationDetailResponseSchema,
  ApproveRegularisationRequestSchema,
  RejectRegularisationRequestSchema,
  HolidaySchema,
  HolidayListResponseSchema,
  ReplaceHolidaysRequestSchema,
} from '@nexora/contracts/attendance';
import {
  PayrollRunStatusSchema,
  PayslipStatusSchema,
  PayrollRunSchema,
  PayrollRunSummarySchema,
  PayslipSchema,
  PayslipSummarySchema,
  CreatePayrollRunRequestSchema,
  CreatePayrollRunResponseSchema,
  PayrollRunListQuerySchema,
  PayrollRunListResponseSchema,
  PayrollRunDetailResponseSchema,
  FinaliseRunRequestSchema,
  FinaliseRunResponseSchema,
  ReverseRunRequestSchema,
  ReverseRunResponseSchema,
  PayslipListQuerySchema,
  PayslipListResponseSchema,
  PayslipDetailResponseSchema,
  UpdatePayslipTaxRequestSchema,
  UpdatePayslipTaxResponseSchema,
  ReversalHistoryItemSchema,
  ReversalHistoryResponseSchema,
  TaxSettingsSchema,
  TaxSettingsResponseSchema,
  UpdateTaxSettingsRequestSchema,
  UpdateTaxSettingsResponseSchema,
  RunAlreadyFinalisedDetailsSchema,
} from '@nexora/contracts/payroll';
import {
  CycleStatusSchema,
  GoalOutcomeSchema,
  GoalSchema,
  PerformanceCycleSchema,
  PerformanceCycleSummarySchema,
  PerformanceReviewSchema,
  PerformanceReviewSummarySchema,
  CreateCycleRequestSchema,
  CreateCycleResponseSchema,
  CloseCycleRequestSchema,
  CloseCycleResponseSchema,
  CycleListQuerySchema,
  CycleListResponseSchema,
  CycleDetailResponseSchema,
  ReviewListQuerySchema,
  ReviewListResponseSchema,
  ReviewDetailResponseSchema,
  CreateGoalRequestSchema,
  CreateGoalResponseSchema,
  ProposeGoalRequestSchema,
  ProposeGoalResponseSchema,
  SelfRatingRequestSchema,
  SelfRatingResponseSchema,
  ManagerRatingRequestSchema,
  ManagerRatingResponseSchema,
  DistributionBucketSchema,
  DistributionReportResponseSchema,
  MissingReviewItemSchema,
  MissingReviewsResponseSchema,
} from '@nexora/contracts/performance';
import {
  NotificationCategorySchema,
  NotificationSchema,
  NotificationListQuerySchema,
  NotificationListResponseSchema,
  MarkReadRequestSchema,
  MarkReadResponseSchema,
  UnreadCountResponseSchema,
} from '@nexora/contracts/notifications';
import {
  AuditLogEntrySchema,
  AuditLogListQuerySchema,
  AuditLogListResponseSchema,
} from '@nexora/contracts/audit';
import {
  AttendanceConfigSchema,
  AttendanceConfigResponseSchema,
  UpdateAttendanceConfigSchema,
  LeaveConfigSchema,
  LeaveConfigResponseSchema,
  UpdateLeaveConfigSchema,
} from '@nexora/contracts/configuration';

// Augment the local `z` with .openapi() — required before any registry call.
extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// ── Components — shared schemas ─────────────────────────────────────────────

registry.register('Role', RoleSchema);
registry.register('EmployeeStatus', EmployeeStatusSchema);
registry.register('EmploymentType', EmploymentTypeSchema);
registry.register('AuthUser', AuthUserSchema);
registry.register('ErrorEnvelope', ErrorEnvelopeSchema);

registry.register('LoginRequest', LoginRequestSchema);
registry.register('LoginResponse', LoginResponseSchema);
registry.register('LogoutResponse', LogoutResponseSchema);
registry.register('ForgotPasswordRequest', ForgotPasswordRequestSchema);
registry.register('ForgotPasswordResponse', ForgotPasswordResponseSchema);
registry.register('ResetPasswordRequest', ResetPasswordRequestSchema);
registry.register('ResetPasswordResponse', ResetPasswordResponseSchema);
registry.register('FirstLoginSetPasswordRequest', FirstLoginSetPasswordRequestSchema);
registry.register('FirstLoginSetPasswordResponse', FirstLoginSetPasswordResponseSchema);
registry.register('AuthMeResponse', AuthMeResponseSchema);

// ── Security scheme — session cookie ────────────────────────────────────────

registry.registerComponent('securitySchemes', 'sessionCookie', {
  type: 'apiKey',
  in: 'cookie',
  name: 'nx_session',
  description: 'Signed session cookie set by POST /auth/login.',
});

// ── Reusable response factories ─────────────────────────────────────────────

const errorResponse = (status: number, description: string) => ({
  [status]: {
    description,
    content: {
      'application/json': {
        schema: ErrorEnvelopeSchema,
      },
    },
  },
});

// ── Health ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['Health'],
  summary: 'API liveness check',
  description: 'Returns service status, uptime in seconds, and version. No auth required.',
  responses: {
    200: {
      description: 'Service is up.',
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              status: z.literal('ok'),
              uptime: z.number(),
              version: z.string(),
            }),
          }),
        },
      },
    },
  },
});

// ── Auth ────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  tags: ['Auth'],
  summary: 'Sign in with email + password',
  description:
    'Returns the user payload and sets the `nx_session` HttpOnly cookie. ' +
    'Five wrong attempts in a 15-minute window lock the account (BL-005, returns 423).',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: LoginRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Authenticated. Sets `nx_session` cookie.',
      content: { 'application/json': { schema: LoginResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED — invalid request body.'),
    ...errorResponse(401, 'INVALID_CREDENTIALS — email/password mismatch.'),
    ...errorResponse(423, 'LOCKED — too many failed attempts.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/logout',
  tags: ['Auth'],
  summary: 'Invalidate the current session',
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: 'Session destroyed; cookie cleared.',
      content: { 'application/json': { schema: LogoutResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED — no active session.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/forgot-password',
  tags: ['Auth'],
  summary: 'Request a password-reset link',
  description:
    'Always returns 200 regardless of whether the email matches an account ' +
    '(no enumeration leak). When the email matches an Active employee, an ' +
    'email containing a single-use link with a 30-minute TTL is dispatched.',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: ForgotPasswordRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Generic success. The body never reveals whether the email exists.',
      content: { 'application/json': { schema: ForgotPasswordResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED — invalid request body.'),
    ...errorResponse(429, 'RATE_LIMITED — too many requests; retry later.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/reset-password',
  tags: ['Auth'],
  summary: 'Set a new password using a reset token',
  description:
    'Validates the token (single-use, 30-min TTL), updates the password ' +
    'hash, and invalidates ALL active sessions for the user.',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: ResetPasswordRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Password updated; all sessions for the user invalidated.',
      content: { 'application/json': { schema: ResetPasswordResponseSchema } },
    },
    ...errorResponse(400, 'TOKEN_INVALID or TOKEN_EXPIRED.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/first-login/set-password',
  tags: ['Auth'],
  summary: 'Activate an account via the first-login token',
  description:
    'Used by employees on their first sign-in. Sets the password, clears ' +
    '`mustResetPassword`, flips status to Active, and creates a session.',
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: FirstLoginSetPasswordRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Account activated; session established.',
      content: { 'application/json': { schema: FirstLoginSetPasswordResponseSchema } },
    },
    ...errorResponse(400, 'TOKEN_INVALID or TOKEN_EXPIRED.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/auth/me',
  tags: ['Auth'],
  summary: 'Return the current session user',
  description:
    'Returns the authenticated user, role, and a permission token list ' +
    'derived server-side from the role.',
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: 'Current user payload.',
      content: { 'application/json': { schema: AuthMeResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED — no active session.'),
  },
});

// ── Phase 1 — Employees & Hierarchy ─────────────────────────────────────────

registry.register('SalaryStructure', SalaryStructureSchema);
registry.register('EmployeeDetail', EmployeeDetailSchema);
registry.register('CreateEmployeeRequest', CreateEmployeeRequestSchema);
registry.register('CreateEmployeeResponse', CreateEmployeeResponseSchema);
registry.register('EmployeeListQuery', EmployeeListQuerySchema);
registry.register('EmployeeListResponse', EmployeeListResponseSchema);
registry.register('EmployeeDetailResponse', EmployeeDetailResponseSchema);
registry.register('UpdateEmployeeRequest', UpdateEmployeeRequestSchema);
registry.register('UpdateEmployeeResponse', UpdateEmployeeResponseSchema);
registry.register('UpdateSalaryRequest', UpdateSalaryRequestSchema);
registry.register('UpdateSalaryResponse', UpdateSalaryResponseSchema);
registry.register('ChangeStatusRequest', ChangeStatusRequestSchema);
registry.register('ChangeStatusResponse', ChangeStatusResponseSchema);
registry.register('ReassignManagerRequest', ReassignManagerRequestSchema);
registry.register('ReassignManagerResponse', ReassignManagerResponseSchema);
registry.register('TeamResponse', TeamResponseSchema);
registry.register('ProfileResponse', ProfileResponseSchema);

registry.registerPath({
  method: 'post',
  path: '/employees',
  tags: ['Employees'],
  summary: 'Create a new employee (Admin only)',
  description:
    'Generates EMP-YYYY-NNNN code, creates employee record, sends first-login invitation email. ' +
    'BL-008: code is unique and never reused.',
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateEmployeeRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Employee created. Returns the full detail + invitationSent flag.',
      content: { 'application/json': { schema: CreateEmployeeResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED — invalid body or duplicate email.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — caller is not Admin.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/employees',
  tags: ['Employees'],
  summary: 'List employees (Admin: all; Manager: scoped to team)',
  description:
    'Cursor-paginated. Managers see only direct + indirect reports. ' +
    'Filters: status, role, department, employmentType, managerId, q (name/email/code/department/designation).',
  security: [{ sessionCookie: [] }],
  request: {
    query: EmployeeListQuerySchema,
  },
  responses: {
    200: {
      description: 'Paginated list of employees.',
      content: { 'application/json': { schema: EmployeeListResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED — invalid query params.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — caller is not Admin or Manager.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/employees/{id}',
  tags: ['Employees'],
  summary: 'Get employee detail',
  description:
    'Admin sees all. SELF sees own record with salary. Manager sees team members (salary omitted).',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Employee detail.',
      content: { 'application/json': { schema: EmployeeDetailResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(404, 'NOT_FOUND — employee does not exist or is outside caller scope.'),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/employees/{id}',
  tags: ['Employees'],
  summary: 'Update employee profile (Admin only)',
  description:
    'Partial update. Email and code are immutable. Uses optimistic concurrency via `version` (BL-034). ' +
    'Status changes use POST /employees/{id}/status; salary changes use PATCH /employees/{id}/salary.',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateEmployeeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated employee detail.',
      content: { 'application/json': { schema: UpdateEmployeeResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'VERSION_MISMATCH — stale concurrency token.'),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/employees/{id}/salary',
  tags: ['Employees'],
  summary: 'Update salary structure (Admin only)',
  description:
    'Inserts a NEW salary row; historical salary rows and past payslips are never mutated (BL-030 / BL-031). ' +
    'Active structure for a given run = latest effectiveFrom <= run month start.',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateSalaryRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated employee detail with new active salary.',
      content: { 'application/json': { schema: UpdateSalaryResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'VERSION_MISMATCH.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/employees/{id}/status',
  tags: ['Employees'],
  summary: 'Change employee status (Admin only)',
  description:
    'Allowed manual transitions: Active, On-Notice, Exited. ' +
    'On-Leave is system-set on leave approval and cannot be set here (BL-006). ' +
    'Exiting an employee closes their open ReportingManagerHistory row (BL-022).',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: ChangeStatusRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated employee detail.',
      content: { 'application/json': { schema: ChangeStatusResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED — including attempted On-Leave set.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'VERSION_MISMATCH.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/employees/{id}/reassign-manager',
  tags: ['Employees'],
  summary: 'Reassign reporting manager (Admin only)',
  description:
    'Validates no circular chain (BL-005). Closes current ReportingManagerHistory row, inserts a new open one. ' +
    'Pass newManagerId=null to promote to top-of-tree.',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: ReassignManagerRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated employee detail.',
      content: { 'application/json': { schema: ReassignManagerResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'CIRCULAR_REPORTING (BL-005) or VERSION_MISMATCH.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/employees/{id}/team',
  tags: ['Employees'],
  summary: 'Get current and past team members',
  description:
    'Manager may only query their own id. Admin may query any manager. ' +
    'Returns current (direct + indirect) and past (BL-022a) team members.',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Current and past team members.',
      content: { 'application/json': { schema: TeamResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — Manager querying another manager\'s team.'),
    ...errorResponse(404, 'NOT_FOUND.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/employees/{id}/profile',
  tags: ['Employees'],
  summary: 'Get own profile (SELF or Admin)',
  description: 'Read-only profile view. Only the employee themselves or Admin may access.',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Full employee detail including salary.',
      content: { 'application/json': { schema: ProfileResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(404, 'NOT_FOUND — or access denied (no leakage).'),
  },
});

// ── Phase 2 — Leave Management ─────────────────────────────────────────────

registry.register('LeaveType', LeaveTypeSchema);
registry.register('LeaveStatus', LeaveStatusSchema);
registry.register('RoutedTo', RoutedToSchema);
registry.register('LeaveBalance', LeaveBalanceSchema);
registry.register('LeaveBalancesResponse', LeaveBalancesResponseSchema);
registry.register('LeaveTypeCatalogItem', LeaveTypeCatalogItemSchema);
registry.register('LeaveTypesResponse', LeaveTypesResponseSchema);
registry.register('LeaveRequest', LeaveRequestSchema);
registry.register('LeaveRequestSummary', LeaveRequestSummarySchema);
registry.register('CreateLeaveRequest', CreateLeaveRequestSchema);
registry.register('CreateLeaveResponse', CreateLeaveResponseSchema);
registry.register('LeaveListQuery', LeaveListQuerySchema);
registry.register('LeaveListResponse', LeaveListResponseSchema);
registry.register('LeaveRequestDetailResponse', LeaveRequestDetailResponseSchema);
registry.register('ApproveLeaveRequest', ApproveLeaveRequestSchema);
registry.register('ApproveLeaveResponse', ApproveLeaveResponseSchema);
registry.register('RejectLeaveRequest', RejectLeaveRequestSchema);
registry.register('RejectLeaveResponse', RejectLeaveResponseSchema);
registry.register('CancelLeaveRequest', CancelLeaveRequestSchema);
registry.register('CancelLeaveResponse', CancelLeaveResponseSchema);
registry.register('LeaveConflictDetails', LeaveConflictDetailsSchema);
registry.register('AdjustBalanceRequest', AdjustBalanceRequestSchema);
registry.register('AdjustBalanceResponse', AdjustBalanceResponseSchema);
registry.register('UpdateLeaveTypeRequest', UpdateLeaveTypeRequestSchema);
registry.register('UpdateLeaveQuotaRequest', UpdateLeaveQuotaRequestSchema);

registry.registerPath({
  method: 'get',
  path: '/leave/types',
  tags: ['Leave'],
  summary: 'Get leave type catalogue (all roles)',
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: 'Leave type catalogue with quotas per employment type.',
      content: { 'application/json': { schema: LeaveTypesResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/leave/balances/{employeeId}',
  tags: ['Leave'],
  summary: 'Get leave balances for an employee (SELF / Manager / Admin)',
  description:
    'Returns the current-year balance for every leave type. ' +
    'Event-based types (Maternity/Paternity) show null remaining / total with an `eligible` flag.',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({ employeeId: z.string() }) },
  responses: {
    200: {
      description: 'Leave balances for the requested year.',
      content: { 'application/json': { schema: LeaveBalancesResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — caller is not authorised for this employee.'),
    ...errorResponse(404, 'NOT_FOUND — employee does not exist or outside caller scope.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/leave/requests',
  tags: ['Leave'],
  summary: 'Submit a leave request (any authenticated user)',
  description:
    'BL-009: returns 409 LEAVE_OVERLAP if dates clash with an existing request. ' +
    'BL-010: returns 409 LEAVE_REG_CONFLICT if dates clash with an approved regularisation. ' +
    'BL-014: returns 409 INSUFFICIENT_BALANCE if balance is insufficient. ' +
    'Routing: Maternity/Paternity → Admin (BL-015/016); no-manager → Admin (BL-017); else Manager.',
  security: [{ sessionCookie: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateLeaveRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Leave request created. Balance snapshot before deduction.',
      content: { 'application/json': { schema: CreateLeaveResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED — invalid body.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(409, 'LEAVE_OVERLAP | LEAVE_REG_CONFLICT | INSUFFICIENT_BALANCE.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/leave/requests',
  tags: ['Leave'],
  summary: 'List leave requests (scoped by role)',
  description:
    'Employee: own requests only. Manager: own + team requests where they are the approver. ' +
    'Admin: all requests with optional ?routedTo filter for escalations/event-based queue.',
  security: [{ sessionCookie: [] }],
  request: { query: LeaveListQuerySchema },
  responses: {
    200: {
      description: 'Paginated list of leave request summaries.',
      content: { 'application/json': { schema: LeaveListResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/leave/requests/{id}',
  tags: ['Leave'],
  summary: 'Get leave request detail',
  description:
    'Returns full detail. Accessible by: owner, current approverId, Admin, or Manager-in-chain. ' +
    '404 when not visible (no leakage).',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Full leave request detail.',
      content: { 'application/json': { schema: LeaveRequestDetailResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(404, 'NOT_FOUND.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/leave/requests/{id}/approve',
  tags: ['Leave'],
  summary: 'Approve a leave request',
  description:
    'BL-021: balance deducted immediately on approval. ' +
    'Uses optimistic concurrency via `version`. ' +
    'Manager may only approve requests in their queue (approverId == self).',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: { 'application/json': { schema: ApproveLeaveRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Approved leave request with deducted balance.',
      content: { 'application/json': { schema: ApproveLeaveResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'VERSION_MISMATCH or invalid status transition.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/leave/requests/{id}/reject',
  tags: ['Leave'],
  summary: 'Reject a leave request (note required)',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: { 'application/json': { schema: RejectLeaveRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Rejected leave request.',
      content: { 'application/json': { schema: RejectLeaveResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED — note is required (min 3 chars).'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'VERSION_MISMATCH.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/leave/requests/{id}/cancel',
  tags: ['Leave'],
  summary: 'Cancel a leave request (BL-019 / BL-020)',
  description:
    'BL-019: Owner may cancel if Pending or Approved-before-start. Manager/Admin may always cancel. ' +
    'BL-020: full restore before start; partial restore after start (days already consumed deducted).',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: { 'application/json': { schema: CancelLeaveRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Cancelled request with restoredDays.',
      content: { 'application/json': { schema: CancelLeaveResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'VERSION_MISMATCH.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/leave/balances/adjust',
  tags: ['Leave'],
  summary: 'Admin: adjust an employee leave balance (A-07)',
  description:
    'One-off balance correction. Positive delta = grant; negative = deduct. ' +
    'Always audit-logged with before/after. Integer days only (BL-011).',
  security: [{ sessionCookie: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: AdjustBalanceRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Updated balance snapshot.',
      content: { 'application/json': { schema: AdjustBalanceResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — Admin only.'),
    ...errorResponse(404, 'NOT_FOUND.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/leave/config/types',
  tags: ['Leave'],
  summary: 'Get leave type catalogue (admin config UI alias)',
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: 'Leave type catalogue.',
      content: { 'application/json': { schema: LeaveTypesResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/leave/config/types/{type}',
  tags: ['Leave'],
  summary: 'Update leave type config (A-08, Admin only)',
  description: 'Update carryForwardCap or maxDaysPerEvent for a leave type. Audit-logged.',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ type: z.string() }),
    body: { required: true, content: { 'application/json': { schema: UpdateLeaveTypeRequestSchema } } },
  },
  responses: {
    200: { description: 'Updated leave type config.' },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — Admin only.'),
    ...errorResponse(404, 'NOT_FOUND.'),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/leave/config/quotas/{type}',
  tags: ['Leave'],
  summary: 'Update leave quota for an employment type (A-08, Admin only)',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ type: z.string() }),
    body: { required: true, content: { 'application/json': { schema: UpdateLeaveQuotaRequestSchema } } },
  },
  responses: {
    200: { description: 'Updated quota.' },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — Admin only.'),
    ...errorResponse(404, 'NOT_FOUND.'),
  },
});

// ── Phase 3 — Attendance & Regularisation components ────────────────────────

registry.register('AttendanceStatus', AttendanceStatusSchema);
registry.register('AttendanceSource', AttendanceSourceSchema);
registry.register('AttendanceRecord', AttendanceRecordSchema);
registry.register('AttendanceCalendarItem', AttendanceCalendarItemSchema);
registry.register('CheckInRequest', CheckInRequestSchema);
registry.register('CheckInResponse', CheckInResponseSchema);
registry.register('CheckOutRequest', CheckOutRequestSchema);
registry.register('CheckOutResponse', CheckOutResponseSchema);
registry.register('AttendanceListQuery', AttendanceListQuerySchema);
registry.register('AttendanceListResponse', AttendanceListResponseSchema);
registry.register('TodayAttendanceResponse', TodayAttendanceResponseSchema);
registry.register('RegStatus', RegStatusSchema);
registry.register('RegRoutedTo', RegRoutedToSchema);
registry.register('RegularisationRequest', RegularisationRequestSchema);
registry.register('RegularisationSummary', RegularisationSummarySchema);
registry.register('CreateRegularisationRequest', CreateRegularisationRequestSchema);
registry.register('CreateRegularisationResponse', CreateRegularisationResponseSchema);
registry.register('RegularisationListQuery', RegularisationListQuerySchema);
registry.register('RegularisationListResponse', RegularisationListResponseSchema);
registry.register('RegularisationDetailResponse', RegularisationDetailResponseSchema);
registry.register('ApproveRegularisationRequest', ApproveRegularisationRequestSchema);
registry.register('RejectRegularisationRequest', RejectRegularisationRequestSchema);
registry.register('Holiday', HolidaySchema);
registry.register('HolidayListResponse', HolidayListResponseSchema);
registry.register('ReplaceHolidaysRequest', ReplaceHolidaysRequestSchema);

// ── Phase 3 — Attendance endpoints ──────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/attendance/check-in',
  tags: ['Attendance'],
  summary: 'Record check-in for today (BL-027 / BL-028)',
  description:
    'Stamps the current server time as check-in. Idempotent — a second call returns ' +
    'the existing record. Computes late mark against configured LATE_THRESHOLD (BL-027). ' +
    'If the monthly late count reaches a multiple of 3, deducts 1 day from Annual leave (BL-028).',
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: 'Check-in recorded. lateMarkDeductionApplied=true when BL-028 fired.',
      content: { 'application/json': { schema: CheckInResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(500, 'INTERNAL_ERROR.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/attendance/check-out',
  tags: ['Attendance'],
  summary: 'Record check-out for today (BL-025)',
  description:
    'Stamps the current server time as check-out. Requires an earlier check-in today (BL-024). ' +
    'Computes hoursWorkedMinutes = checkOut − checkIn. Idempotent.',
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: 'Check-out recorded.',
      content: { 'application/json': { schema: CheckOutResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED — no check-in for today (BL-024).'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(500, 'INTERNAL_ERROR.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/attendance/me/today',
  tags: ['Attendance'],
  summary: "Today's attendance panel state",
  description:
    'Returns the check-in panel UI state: Ready (no check-in), Working (checked in), ' +
    'Confirm (checked out). Also returns the configured lateThreshold and standardDailyHours (BL-025a).',
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: "Today's attendance record and panel state.",
      content: { 'application/json': { schema: TodayAttendanceResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/attendance/me',
  tags: ['Attendance'],
  summary: 'Own attendance history (calendar month default)',
  description: 'Returns attendance records for the requesting employee. ' +
    'Defaults to the current calendar month. Supports date range (?from, ?to) or single day (?date).',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({}), query: AttendanceListQuerySchema },
  responses: {
    200: {
      description: 'Attendance records.',
      content: { 'application/json': { schema: AttendanceListResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/attendance/team',
  tags: ['Attendance'],
  summary: "Team attendance (Manager's subordinates)",
  description: 'Returns attendance for all direct and indirect reports of the requesting Manager. ' +
    'Optional ?employeeId restricts to one team member.',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({}), query: AttendanceListQuerySchema },
  responses: {
    200: {
      description: 'Team attendance records.',
      content: { 'application/json': { schema: AttendanceListResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — Manager or Admin only.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/attendance',
  tags: ['Attendance'],
  summary: 'Org-wide attendance (Admin)',
  description: 'Returns attendance for all employees. Optional ?department and ?employeeId filters.',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({}), query: AttendanceListQuerySchema },
  responses: {
    200: {
      description: 'Org-wide attendance records.',
      content: { 'application/json': { schema: AttendanceListResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — Admin only.'),
  },
});

// ── Phase 3 — Regularisation endpoints ──────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/regularisations',
  tags: ['Regularisation'],
  summary: 'Submit a regularisation request (BL-010 / BL-029)',
  description:
    'Submits a request to correct a past attendance record. ' +
    'BL-010: rejected with LEAVE_REG_CONFLICT if an approved leave already covers the date. ' +
    'BL-029: requests ≤7 days old route to the reporting Manager; >7 days route to Admin.',
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateRegularisationRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Regularisation submitted.',
      content: { 'application/json': { schema: CreateRegularisationResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED — date not in past or check-in/out invalid.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(409, 'LEAVE_REG_CONFLICT — approved leave covers this date (BL-010, DN-19).'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/regularisations',
  tags: ['Regularisation'],
  summary: 'List regularisation requests (role-scoped)',
  description:
    'Employee: own requests only. ' +
    'Manager: own + subordinates\' requests where approverId=self. ' +
    'Admin: all requests; optional ?routedTo=Admin filter. ' +
    'PayrollOfficer: own requests only.',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({}), query: RegularisationListQuerySchema },
  responses: {
    200: {
      description: 'Scoped list of regularisation requests.',
      content: { 'application/json': { schema: RegularisationListResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/regularisations/{id}',
  tags: ['Regularisation'],
  summary: 'Get regularisation detail',
  description:
    'Visible to: the employee owner, the current approver, a chain manager, or Admin. ' +
    'Returns 404 (not 403) when the caller cannot see the record.',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Regularisation detail.',
      content: { 'application/json': { schema: RegularisationDetailResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(404, 'NOT_FOUND — not found or not visible.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/regularisations/{id}/approve',
  tags: ['Regularisation'],
  summary: 'Approve a regularisation request',
  description:
    'Allowed for: (Manager AND approverId == self) OR Admin. ' +
    'Creates a new AttendanceRecord row with source=regularisation (BL-007). ' +
    'Original system row is preserved. Version required for optimistic concurrency (BL-034).',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: ApproveRegularisationRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Approved — corrected attendance row created.',
      content: { 'application/json': { schema: RegularisationDetailResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED — already decided.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — not the assigned approver.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'VERSION_MISMATCH — stale version (BL-034).'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/regularisations/{id}/reject',
  tags: ['Regularisation'],
  summary: 'Reject a regularisation request',
  description:
    'Allowed for: (Manager AND approverId == self) OR Admin. ' +
    'Note is required (TC-REG-005). Version required for optimistic concurrency (BL-034).',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: RejectRegularisationRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Rejected.',
      content: { 'application/json': { schema: RegularisationDetailResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED — already decided.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — not the assigned approver.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'VERSION_MISMATCH — stale version (BL-034).'),
  },
});

// ── Phase 3 — Holiday endpoints ──────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/config/holidays',
  tags: ['Holidays'],
  summary: 'Get public holiday calendar for a year',
  description: 'Returns all holiday rows for the given year (default: current year). ' +
    'Available to all signed-in users — used by the client for status derivation (BL-026).',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({}),
    query: z.object({ year: z.coerce.number().int().min(2000).max(2999).optional() }),
  },
  responses: {
    200: {
      description: 'Holiday list for the year.',
      content: { 'application/json': { schema: HolidayListResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

registry.registerPath({
  method: 'put',
  path: '/config/holidays',
  tags: ['Holidays'],
  summary: 'Replace the holiday calendar for a year (Admin)',
  description: 'Atomically replaces all holiday rows for the given year. ' +
    'Deletes existing rows for the year and re-inserts the provided list. ' +
    'Audits config.holidays.replace.',
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: ReplaceHolidaysRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Replaced — returns the new holiday list.',
      content: { 'application/json': { schema: HolidayListResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — Admin only.'),
  },
});

// ── Phase 4 — Payroll Processing ────────────────────────────────────────────

// Register Phase 4 schemas
registry.register('PayrollRunStatus', PayrollRunStatusSchema);
registry.register('PayslipStatus', PayslipStatusSchema);
registry.register('PayrollRun', PayrollRunSchema);
registry.register('PayrollRunSummary', PayrollRunSummarySchema);
registry.register('Payslip', PayslipSchema);
registry.register('PayslipSummary', PayslipSummarySchema);
registry.register('CreatePayrollRunRequest', CreatePayrollRunRequestSchema);
registry.register('CreatePayrollRunResponse', CreatePayrollRunResponseSchema);
registry.register('PayrollRunListQuery', PayrollRunListQuerySchema);
registry.register('PayrollRunListResponse', PayrollRunListResponseSchema);
registry.register('PayrollRunDetailResponse', PayrollRunDetailResponseSchema);
registry.register('FinaliseRunRequest', FinaliseRunRequestSchema);
registry.register('FinaliseRunResponse', FinaliseRunResponseSchema);
registry.register('ReverseRunRequest', ReverseRunRequestSchema);
registry.register('ReverseRunResponse', ReverseRunResponseSchema);
registry.register('PayslipListQuery', PayslipListQuerySchema);
registry.register('PayslipListResponse', PayslipListResponseSchema);
registry.register('PayslipDetailResponse', PayslipDetailResponseSchema);
registry.register('UpdatePayslipTaxRequest', UpdatePayslipTaxRequestSchema);
registry.register('UpdatePayslipTaxResponse', UpdatePayslipTaxResponseSchema);
registry.register('ReversalHistoryItem', ReversalHistoryItemSchema);
registry.register('ReversalHistoryResponse', ReversalHistoryResponseSchema);
registry.register('TaxSettings', TaxSettingsSchema);
registry.register('TaxSettingsResponse', TaxSettingsResponseSchema);
registry.register('UpdateTaxSettingsRequest', UpdateTaxSettingsRequestSchema);
registry.register('UpdateTaxSettingsResponse', UpdateTaxSettingsResponseSchema);
registry.register('RunAlreadyFinalisedDetails', RunAlreadyFinalisedDetailsSchema);

const idempotencyKeyHeader = {
  in: 'header' as const,
  name: 'Idempotency-Key',
  required: false,
  schema: { type: 'string' as const, maxLength: 128 },
  description: 'Optional client-generated idempotency key. Duplicate requests with the same key within 24h return the original response without re-applying side effects.',
};

// POST /payroll/runs
registry.registerPath({
  method: 'post',
  path: '/payroll/runs',
  tags: ['Payroll'],
  summary: 'Initiate a payroll run for a month (Admin/PO) — A-12/P-03',
  description: 'Creates a new payroll run. Computes payslips for all Active/On-Notice employees. BL-030: uses salary structure effective as of period start. BL-035: LOP deduction. BL-036: proration for mid-month joiners/exits. BL-036a: reference tax = gross × STANDARD_TAX_REFERENCE_RATE. Idempotent via Idempotency-Key.',
  security: [{ sessionCookie: [] }],
  parameters: [idempotencyKeyHeader],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreatePayrollRunRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Run created — returns run + payslipCount.',
      content: { 'application/json': { schema: CreatePayrollRunResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — Admin or PayrollOfficer only.'),
    ...errorResponse(409, 'Run already exists for this month/year.'),
  },
});

// GET /payroll/runs
registry.registerPath({
  method: 'get',
  path: '/payroll/runs',
  tags: ['Payroll'],
  summary: 'List payroll runs (Admin/PO) — A-11/P-02',
  security: [{ sessionCookie: [] }],
  request: { query: PayrollRunListQuerySchema },
  responses: {
    200: {
      description: 'Paginated list of payroll run summaries.',
      content: { 'application/json': { schema: PayrollRunListResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
  },
});

// GET /payroll/runs/:id
registry.registerPath({
  method: 'get',
  path: '/payroll/runs/{id}',
  tags: ['Payroll'],
  summary: 'Get a payroll run detail with payslip summaries (Admin/PO) — A-13/P-04',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Run + payslip summaries.',
      content: { 'application/json': { schema: PayrollRunDetailResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
  },
});

// POST /payroll/runs/:id/finalise
registry.registerPath({
  method: 'post',
  path: '/payroll/runs/{id}/finalise',
  tags: ['Payroll'],
  summary: 'Finalise a payroll run (Admin/PO) — A-14/P-05 — BL-034',
  description: 'Two-step: client must send confirm="FINALISE". Uses SELECT…FOR UPDATE to prevent concurrent finalisation (BL-034). Second caller gets 409 RUN_ALREADY_FINALISED with winner details. Idempotent via Idempotency-Key.',
  security: [{ sessionCookie: [] }],
  parameters: [idempotencyKeyHeader],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: FinaliseRunRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Finalised run.',
      content: { 'application/json': { schema: FinaliseRunResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'RUN_ALREADY_FINALISED (BL-034) or VERSION_MISMATCH.'),
  },
});

// POST /payroll/runs/:id/reverse
registry.registerPath({
  method: 'post',
  path: '/payroll/runs/{id}/reverse',
  tags: ['Payroll'],
  summary: 'Reverse a finalised run (Admin only) — A-15 — BL-033',
  description: 'Two-step: client must send confirm="REVERSE" + reason (min 10 chars). Creates a new reversal run + payslips. Source run and payslips are NEVER modified (BL-031/BL-032). Idempotent via Idempotency-Key.',
  security: [{ sessionCookie: [] }],
  parameters: [idempotencyKeyHeader],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: ReverseRunRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Reversal run created.',
      content: { 'application/json': { schema: ReverseRunResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — Admin only.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'Source run is not Finalised.'),
  },
});

// GET /payroll/reversals
registry.registerPath({
  method: 'get',
  path: '/payroll/reversals',
  tags: ['Payroll'],
  summary: 'List all reversal records (Admin/PO) — A-24/P-07',
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: 'Paginated list of reversal history items.',
      content: { 'application/json': { schema: ReversalHistoryResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
  },
});

// GET /payslips
registry.registerPath({
  method: 'get',
  path: '/payslips',
  tags: ['Payslips'],
  summary: 'List payslips — scoped by role — E-08',
  description: 'Employee: own only. Manager: own + subordinate tree. PO/Admin: all.',
  security: [{ sessionCookie: [] }],
  request: { query: PayslipListQuerySchema },
  responses: {
    200: {
      description: 'Paginated payslip summaries.',
      content: { 'application/json': { schema: PayslipListResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

// GET /payslips/:id
registry.registerPath({
  method: 'get',
  path: '/payslips/{id}',
  tags: ['Payslips'],
  summary: 'Get a payslip detail — E-09',
  description: 'Returns 404 if the caller cannot see this payslip (no existence leak).',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Payslip detail.',
      content: { 'application/json': { schema: PayslipDetailResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(404, 'NOT_FOUND.'),
  },
});

// PATCH /payslips/:id/tax
registry.registerPath({
  method: 'patch',
  path: '/payslips/{id}/tax',
  tags: ['Payslips'],
  summary: 'Update final tax on a payslip (PO/Admin) — BL-036a',
  description: 'Only allowed while parent run is Draft or Review. Returns 409 PAYSLIP_IMMUTABLE (BL-031) if Finalised or Reversed. Recomputes netPayPaise on change. Idempotent via Idempotency-Key.',
  security: [{ sessionCookie: [] }],
  parameters: [idempotencyKeyHeader],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: UpdatePayslipTaxRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated payslip.',
      content: { 'application/json': { schema: UpdatePayslipTaxResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'PAYSLIP_IMMUTABLE (BL-031) or VERSION_MISMATCH.'),
  },
});

// GET /payslips/:id/pdf
registry.registerPath({
  method: 'get',
  path: '/payslips/{id}/pdf',
  tags: ['Payslips'],
  summary: 'Download payslip as PDF — E-08',
  description: 'Streams a server-rendered PDF (pdfkit). Content-Disposition: attachment. Applies same visibility rules as GET /payslips/:id.',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'PDF file stream.',
      content: { 'application/pdf': { schema: z.string() } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(404, 'NOT_FOUND.'),
  },
});

// GET /config/tax
registry.registerPath({
  method: 'get',
  path: '/config/tax',
  tags: ['TaxConfig'],
  summary: 'Get the standard tax reference rate (Admin) — A-17',
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: 'Current tax settings.',
      content: { 'application/json': { schema: TaxSettingsResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — Admin only.'),
  },
});

// PATCH /config/tax
registry.registerPath({
  method: 'patch',
  path: '/config/tax',
  tags: ['TaxConfig'],
  summary: 'Update the standard tax reference rate (Admin) — A-17',
  description: 'Updates STANDARD_TAX_REFERENCE_RATE. Idempotent via Idempotency-Key.',
  security: [{ sessionCookie: [] }],
  parameters: [idempotencyKeyHeader],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateTaxSettingsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated tax settings.',
      content: { 'application/json': { schema: UpdateTaxSettingsResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — Admin only.'),
  },
});

// ── Phase 5 — Performance Reviews ───────────────────────────────────────────

registry.register('CycleStatus', CycleStatusSchema);
registry.register('GoalOutcome', GoalOutcomeSchema);
registry.register('Goal', GoalSchema);
registry.register('PerformanceCycle', PerformanceCycleSchema);
registry.register('PerformanceCycleSummary', PerformanceCycleSummarySchema);
registry.register('PerformanceReview', PerformanceReviewSchema);
registry.register('PerformanceReviewSummary', PerformanceReviewSummarySchema);
registry.register('CreateCycleRequest', CreateCycleRequestSchema);
registry.register('CreateCycleResponse', CreateCycleResponseSchema);
registry.register('CloseCycleRequest', CloseCycleRequestSchema);
registry.register('CloseCycleResponse', CloseCycleResponseSchema);
registry.register('CycleListQuery', CycleListQuerySchema);
registry.register('CycleListResponse', CycleListResponseSchema);
registry.register('CycleDetailResponse', CycleDetailResponseSchema);
registry.register('ReviewListQuery', ReviewListQuerySchema);
registry.register('ReviewListResponse', ReviewListResponseSchema);
registry.register('ReviewDetailResponse', ReviewDetailResponseSchema);
registry.register('CreateGoalRequest', CreateGoalRequestSchema);
registry.register('CreateGoalResponse', CreateGoalResponseSchema);
registry.register('ProposeGoalRequest', ProposeGoalRequestSchema);
registry.register('ProposeGoalResponse', ProposeGoalResponseSchema);
registry.register('SelfRatingRequest', SelfRatingRequestSchema);
registry.register('SelfRatingResponse', SelfRatingResponseSchema);
registry.register('ManagerRatingRequest', ManagerRatingRequestSchema);
registry.register('ManagerRatingResponse', ManagerRatingResponseSchema);
registry.register('DistributionBucket', DistributionBucketSchema);
registry.register('DistributionReportResponse', DistributionReportResponseSchema);
registry.register('MissingReviewItem', MissingReviewItemSchema);
registry.register('MissingReviewsResponse', MissingReviewsResponseSchema);

registry.registerPath({
  method: 'post',
  path: '/performance/cycles',
  tags: ['Performance'],
  summary: 'Create a performance cycle (Admin)',
  description:
    'Creates a new fiscal-half cycle in Open status. Identifies participants ' +
    '(Active employees with joinDate <= fyStart). Mid-cycle joiners get ' +
    'isMidCycleJoiner=true. Option B: adminPeerReviewers map pairs each Admin ' +
    'with a peer-Admin reviewer.',
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateCycleRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Cycle created.',
      content: { 'application/json': { schema: CreateCycleResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED or INVALID_DATE_RANGE.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — not Admin.'),
    ...errorResponse(409, 'Cycle code already exists.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/performance/cycles',
  tags: ['Performance'],
  summary: 'List performance cycles',
  description: 'Paginated list of cycles. All authenticated users may query.',
  security: [{ sessionCookie: [] }],
  request: {
    query: CycleListQuerySchema,
  },
  responses: {
    200: {
      description: 'Cycle list.',
      content: { 'application/json': { schema: CycleListResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/performance/cycles/{id}',
  tags: ['Performance'],
  summary: 'Get cycle detail',
  description:
    'Returns cycle + scoped reviews. Admin sees all; Manager sees team; Employee sees own.',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Cycle detail.',
      content: { 'application/json': { schema: CycleDetailResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(404, 'NOT_FOUND.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/performance/cycles/{id}/close',
  tags: ['Performance'],
  summary: 'Close a performance cycle (Admin)',
  description:
    'Two-step destructive confirm (body must contain confirm: "CLOSE"). ' +
    'Locks all final ratings (BL-041). Returns 409 CYCLE_CLOSED if already closed.',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: CloseCycleRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Cycle closed.',
      content: { 'application/json': { schema: CloseCycleResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'CYCLE_CLOSED or VERSION_MISMATCH.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/performance/cycles/{id}/reports/distribution',
  tags: ['Performance'],
  summary: 'Rating distribution report (A-22)',
  description: 'Rating distribution bucketed by department × rating 1–5 + notRated. Admin only.',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Distribution report.',
      content: { 'application/json': { schema: DistributionReportResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/performance/cycles/{id}/reports/missing',
  tags: ['Performance'],
  summary: 'Missing reviews report (A-23)',
  description: 'Employees with no submitted manager rating in this cycle. Admin only.',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Missing reviews.',
      content: { 'application/json': { schema: MissingReviewsResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN.'),
    ...errorResponse(404, 'NOT_FOUND.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/performance/reviews',
  tags: ['Performance'],
  summary: 'List performance reviews',
  description:
    'Scoped: Admin → all; Manager → own-managed or subordinates; Employee → own only.',
  security: [{ sessionCookie: [] }],
  request: { query: ReviewListQuerySchema },
  responses: {
    200: {
      description: 'Review list.',
      content: { 'application/json': { schema: ReviewListResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/performance/reviews/{id}',
  tags: ['Performance'],
  summary: 'Get review detail',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Review detail.',
      content: { 'application/json': { schema: ReviewDetailResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(404, 'NOT_FOUND — or not visible to caller.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/performance/reviews/{id}/goals',
  tags: ['Performance'],
  summary: 'Create a goal (Manager or Admin)',
  description:
    'Manager (assigned) or Admin adds a goal to a review. Cycle must not be Closed. ' +
    'Hard cap: 20 goals per review.',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: CreateGoalRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Goal created.',
      content: { 'application/json': { schema: CreateGoalResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — not assigned manager or Admin.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'CYCLE_CLOSED or CYCLE_PHASE (mid-cycle joiner).'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/performance/reviews/{id}/goals/propose',
  tags: ['Performance'],
  summary: 'Propose a goal (Employee)',
  description:
    'Employee may propose additional goals during the self-review window (BL-038). ' +
    'Outcome stays Pending until the manager rates it.',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: ProposeGoalRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Goal proposed.',
      content: { 'application/json': { schema: ProposeGoalResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — not the review owner.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'CYCLE_CLOSED or CYCLE_PHASE (outside self-review window).'),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/performance/reviews/{id}/self-rating',
  tags: ['Performance'],
  summary: 'Submit self-rating (Employee)',
  description:
    'Employee submits / updates self-rating and note. Editable until selfReviewDeadline (BL-039).',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: SelfRatingRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Self-rating saved.',
      content: { 'application/json': { schema: SelfRatingResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — not the review owner.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'CYCLE_CLOSED, CYCLE_PHASE (outside deadline), or VERSION_MISMATCH.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/performance/reviews/{id}/manager-rating',
  tags: ['Performance'],
  summary: 'Submit manager rating (Manager or Admin)',
  description:
    'Manager (assigned) or Admin submits the manager rating and per-goal outcomes. ' +
    'Sets managerOverrodeSelf when rating differs from selfRating (BL-040). ' +
    'Editable until managerReviewDeadline.',
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: ManagerRatingRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Manager rating saved.',
      content: { 'application/json': { schema: ManagerRatingResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
    ...errorResponse(403, 'FORBIDDEN — not assigned manager or Admin.'),
    ...errorResponse(404, 'NOT_FOUND.'),
    ...errorResponse(409, 'CYCLE_CLOSED, CYCLE_PHASE (outside deadline), or VERSION_MISMATCH.'),
  },
});

// ── Phase 6 — Notifications ──────────────────────────────────────────────────

registry.register('NotificationCategory', NotificationCategorySchema);
registry.register('Notification', NotificationSchema);
registry.register('NotificationListQuery', NotificationListQuerySchema);
registry.register('NotificationListResponse', NotificationListResponseSchema);
registry.register('MarkReadRequest', MarkReadRequestSchema);
registry.register('MarkReadResponse', MarkReadResponseSchema);
registry.register('UnreadCountResponse', UnreadCountResponseSchema);

// GET /notifications
registry.registerPath({
  method: 'get',
  path: '/notifications',
  tags: ['Notifications'],
  summary: 'List own notification feed',
  description:
    'Returns the authenticated user\'s notification feed, newest first. ' +
    'BL-044: always scoped to recipientId = current user — no cross-user exposure. ' +
    'Cursor-paginated. Supports ?category, ?unread, and ?since filters.',
  security: [{ sessionCookie: [] }],
  request: {
    query: NotificationListQuerySchema,
  },
  responses: {
    200: {
      description: 'Notification feed returned.',
      content: { 'application/json': { schema: NotificationListResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

// POST /notifications/mark-read
registry.registerPath({
  method: 'post',
  path: '/notifications/mark-read',
  tags: ['Notifications'],
  summary: 'Mark notifications as read',
  description:
    'Mark specific notification IDs or ALL unread items as read. ' +
    'BL-044: intersection with recipientId = current user is always enforced — ' +
    'a caller cannot affect another user\'s feed. Returns the number of rows updated.',
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: MarkReadRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Notifications marked as read.',
      content: { 'application/json': { schema: MarkReadResponseSchema } },
    },
    ...errorResponse(400, 'VALIDATION_FAILED — body does not match schema.'),
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

// GET /notifications/unread-count
registry.registerPath({
  method: 'get',
  path: '/notifications/unread-count',
  tags: ['Notifications'],
  summary: 'Get unread notification count',
  description:
    'Lightweight count(*) query for the header bell icon. ' +
    'BL-044: always scoped to the authenticated user.',
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: 'Unread count returned.',
      content: { 'application/json': { schema: UnreadCountResponseSchema } },
    },
    ...errorResponse(401, 'UNAUTHENTICATED.'),
  },
});

// ── Audit Log (Phase 7) ─────────────────────────────────────────────────────

registry.register('AuditLogEntry', AuditLogEntrySchema);
registry.register('AuditLogListQuery', AuditLogListQuerySchema);
registry.register('AuditLogListResponse', AuditLogListResponseSchema);

registry.registerPath({
  method: 'get',
  path: '/audit-logs',
  tags: ['Audit Log'],
  summary: 'List audit log entries (Admin only)',
  description:
    'Returns a cursor-paginated, reverse-chronological list of audit log entries. ' +
    'Supports filtering by actor, module, action, target, and date range. ' +
    'BL-047: append-only — no POST/PUT/DELETE exists on this resource.',
  security: [{ sessionCookie: [] }],
  request: {
    query: AuditLogListQuerySchema,
  },
  responses: {
    200: {
      description: 'Paginated list of audit log entries.',
      content: { 'application/json': { schema: AuditLogListResponseSchema } },
    },
    ...errorResponse(401, 'Not authenticated.'),
    ...errorResponse(403, 'Not authorised — Admin role required.'),
    ...errorResponse(500, 'Internal server error.'),
  },
});

// ── Configuration — Attendance (Phase 7) ────────────────────────────────────

registry.register('AttendanceConfig', AttendanceConfigSchema);
registry.register('AttendanceConfigResponse', AttendanceConfigResponseSchema);
registry.register('UpdateAttendanceConfig', UpdateAttendanceConfigSchema);

registry.registerPath({
  method: 'get',
  path: '/config/attendance',
  tags: ['Configuration'],
  summary: 'Get attendance configuration (Admin only)',
  description:
    'Returns the current attendance configuration: late-threshold time and standard daily hours. ' +
    'Defaults: lateThresholdTime="10:30", standardDailyHours=8.',
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: 'Current attendance configuration.',
      content: { 'application/json': { schema: AttendanceConfigResponseSchema } },
    },
    ...errorResponse(401, 'Not authenticated.'),
    ...errorResponse(403, 'Not authorised — Admin role required.'),
    ...errorResponse(500, 'Internal server error.'),
  },
});

registry.registerPath({
  method: 'put',
  path: '/config/attendance',
  tags: ['Configuration'],
  summary: 'Update attendance configuration (Admin only)',
  description:
    'Atomically updates one or both attendance config keys. Audits each changed key ' +
    'with before/after snapshots. Notifies all active Admins. Busts the 30-second in-process cache.',
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateAttendanceConfigSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated attendance configuration.',
      content: { 'application/json': { schema: AttendanceConfigResponseSchema } },
    },
    ...errorResponse(400, 'Validation failed.'),
    ...errorResponse(401, 'Not authenticated.'),
    ...errorResponse(403, 'Not authorised — Admin role required.'),
    ...errorResponse(500, 'Internal server error.'),
  },
});

// ── Configuration — Leave (Phase 7) ─────────────────────────────────────────

registry.register('LeaveConfig', LeaveConfigSchema);
registry.register('LeaveConfigResponse', LeaveConfigResponseSchema);
registry.register('UpdateLeaveConfig', UpdateLeaveConfigSchema);

registry.registerPath({
  method: 'get',
  path: '/config/leave',
  tags: ['Configuration'],
  summary: 'Get leave configuration (Admin only)',
  description:
    'Returns the current leave configuration: carry-forward caps per type, escalation period, ' +
    'maternity duration, and paternity duration.',
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: 'Current leave configuration.',
      content: { 'application/json': { schema: LeaveConfigResponseSchema } },
    },
    ...errorResponse(401, 'Not authenticated.'),
    ...errorResponse(403, 'Not authorised — Admin role required.'),
    ...errorResponse(500, 'Internal server error.'),
  },
});

registry.registerPath({
  method: 'put',
  path: '/config/leave',
  tags: ['Configuration'],
  summary: 'Update leave configuration (Admin only)',
  description:
    'Atomically updates one or more leave config keys. Audits each changed key. ' +
    'Notifies all active Admins. BL-012 / BL-014: Sick, Unpaid, Maternity, and Paternity ' +
    'carry-forward caps are always forced to 0 regardless of input.',
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateLeaveConfigSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated leave configuration.',
      content: { 'application/json': { schema: LeaveConfigResponseSchema } },
    },
    ...errorResponse(400, 'Validation failed.'),
    ...errorResponse(401, 'Not authenticated.'),
    ...errorResponse(403, 'Not authorised — Admin role required.'),
    ...errorResponse(500, 'Internal server error.'),
  },
});

// ── Build the spec ──────────────────────────────────────────────────────────

const generator = new OpenApiGeneratorV31(registry.definitions);

// Cast to a portable surface — the underlying type lives in `openapi3-ts/oas31`
// which TS warns is not portable across the workspace boundary. Consumers
// only ever serialise this to JSON or hand it to swagger-ui, so the structural
// type is enough.
export const openApiSpec = generator.generateDocument({
  openapi: '3.1.0',
  info: {
    title: 'Nexora HRMS API',
    version: process.env['npm_package_version'] ?? '0.1.0',
    description:
      'REST API for the Nexora HRMS — Indian HR Management System (Triline). ' +
      'Phase 0 covers authentication and account access. Subsequent phases ' +
      'add Employees, Leave, Attendance, Payroll, Performance, Notifications, ' +
      'Audit, and Configuration. See docs/HRMS_API.md for the canonical spec.',
    contact: {
      name: 'Nexora HRMS Team',
      email: 'admin@triline.in',
    },
  },
  servers: [
    {
      url: process.env['API_BASE_URL'] ?? 'http://localhost:4000/api/v1',
      description: 'Local dev',
    },
  ],
});
