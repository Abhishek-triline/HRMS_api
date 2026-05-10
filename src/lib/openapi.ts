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
