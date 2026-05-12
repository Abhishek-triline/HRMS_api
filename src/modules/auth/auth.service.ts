/**
 * Auth service — pure functions (no Express types).
 *
 * Covers:
 *  - Password hashing / verification (argon2id)
 *  - Lockout detection (25-strikes in 5 min)
 *  - Session creation
 *  - Permission derivation from role
 */

import argon2 from 'argon2';
import crypto from 'crypto';
import { prisma } from '../../lib/prisma.js';
import type { AuthPermissionValue } from '@nexora/contracts/auth';
import { AuthPermission } from '@nexora/contracts/auth';
import type { RoleIdValue } from '../../lib/statusInt.js';
import { RoleId } from '../../lib/statusInt.js';

// ── Password ─────────────────────────────────────────────────────────────────

/** Hash a plain-text password with argon2id. */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/**
 * Lazy-initialised argon2id hash of an unguessable random string.
 * Used to keep login response time constant when the email does not exist
 * (SEC-005 — prevents email enumeration via timing side-channel).
 */
let _decoyHash: Promise<string> | null = null;
export function decoyHash(): Promise<string> {
  if (!_decoyHash) {
    const seed = `nx-decoy-${process.pid}-${Date.now()}-${Math.random()}`;
    _decoyHash = argon2.hash(seed, { type: argon2.argon2id });
  }
  return _decoyHash;
}

/** Constant-time comparison of a plain password against a stored hash. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}

// ── Login attempt tracking ────────────────────────────────────────────────────

// Hardcoded — env overrides removed by request. Bump the constants directly
// if you need to tune. 25 failed attempts in a 5-minute window before lockout.
const LOCKOUT_THRESHOLD = 25;
const LOCKOUT_MINUTES = 5;

/**
 * Record a login attempt (success or failure).
 * employeeId may be null when the email doesn't match any account.
 */
export async function recordLoginAttempt(params: {
  email: string;
  ip: string;
  success: boolean;
  employeeId?: number | null;
}): Promise<void> {
  await prisma.loginAttempt.create({
    data: {
      email: params.email.toLowerCase(),
      ip: params.ip,
      success: params.success,
      employeeId: params.employeeId ?? null,
    },
  });
}

/**
 * Returns true if the email+IP combination is currently locked out.
 * Lockout window: LOCKOUT_THRESHOLD failed attempts in last LOCKOUT_MINUTES.
 */
export async function isLockedOut(email: string, ip: string): Promise<boolean> {
  const since = new Date(Date.now() - LOCKOUT_MINUTES * 60 * 1000);

  const failCount = await prisma.loginAttempt.count({
    where: {
      email: email.toLowerCase(),
      ip,
      success: false,
      createdAt: { gte: since },
    },
  });

  return failCount >= LOCKOUT_THRESHOLD;
}

/** Seconds until lockout expires (for Retry-After header). */
export async function lockoutRetryAfterSeconds(email: string, ip: string): Promise<number> {
  const since = new Date(Date.now() - LOCKOUT_MINUTES * 60 * 1000);

  const oldestFailure = await prisma.loginAttempt.findFirst({
    where: {
      email: email.toLowerCase(),
      ip,
      success: false,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (!oldestFailure) return LOCKOUT_MINUTES * 60;

  const expiresAt = new Date(oldestFailure.createdAt.getTime() + LOCKOUT_MINUTES * 60 * 1000);
  const remaining = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  return remaining;
}

// ── Session ───────────────────────────────────────────────────────────────────

const SESSION_TTL_HOURS = Number(process.env['SESSION_TTL_HOURS'] ?? 12);
const SESSION_REMEMBER_ME_DAYS = Number(process.env['SESSION_REMEMBER_ME_DAYS'] ?? 30);

/**
 * Create a new session row and return its token (for the cookie) and sessionId (INT).
 * The cookie is set by the route handler — this only writes the DB row.
 */
export async function createSessionFor(params: {
  employeeId: number;
  ip: string;
  userAgent: string | undefined;
  rememberMe: boolean;
}): Promise<{ sessionId: number; token: string; expiresAt: Date }> {
  const ttlMs = params.rememberMe
    ? SESSION_REMEMBER_ME_DAYS * 24 * 60 * 60 * 1000
    : SESSION_TTL_HOURS * 60 * 60 * 1000;

  const expiresAt = new Date(Date.now() + ttlMs);
  const token = crypto.randomBytes(32).toString('hex');

  const session = await prisma.session.create({
    data: {
      token,
      employeeId: params.employeeId,
      ip: params.ip,
      userAgent: params.userAgent ?? null,
      expiresAt,
    },
  });

  return { sessionId: session.id, token, expiresAt };
}

// ── Permissions ───────────────────────────────────────────────────────────────

const ROLE_PERMISSIONS: Record<RoleIdValue, AuthPermissionValue[]> = {
  [RoleId.Employee]: [],
  [RoleId.Manager]: [
    AuthPermission.EMPLOYEES_READ,
    AuthPermission.LEAVE_APPROVE,
    AuthPermission.ATTENDANCE_REGULARISE_APPROVE,
  ],
  [RoleId.PayrollOfficer]: [
    AuthPermission.EMPLOYEES_READ,
    AuthPermission.PAYROLL_RUN,
    AuthPermission.PAYROLL_FINALISE,
    // PAYROLL_REVERSE intentionally omitted — Admin-only per BL-033 / DN-12 (SEC-003).
  ],
  [RoleId.Admin]: [
    AuthPermission.EMPLOYEES_READ,
    AuthPermission.EMPLOYEES_WRITE,
    AuthPermission.LEAVE_APPROVE,
    AuthPermission.LEAVE_APPROVE_ADMIN,
    AuthPermission.ATTENDANCE_REGULARISE_APPROVE,
    AuthPermission.PAYROLL_RUN,
    AuthPermission.PAYROLL_FINALISE,
    AuthPermission.PAYROLL_REVERSE,
    AuthPermission.PERFORMANCE_CYCLE_MANAGE,
    AuthPermission.CONFIG_WRITE,
    AuthPermission.AUDIT_READ,
  ],
};

/**
 * Derive the permission array for a given roleId.
 * Used by GET /auth/me to surface fine-grained frontend gating.
 */
export function permissionsFor(roleId: RoleIdValue): AuthPermissionValue[] {
  return ROLE_PERMISSIONS[roleId] ?? [];
}

// ── Token utilities ───────────────────────────────────────────────────────────

/** Generate a cryptographically secure random token (hex). */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** SHA-256 hash of a raw token — what we store in the DB. */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
