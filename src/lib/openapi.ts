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
