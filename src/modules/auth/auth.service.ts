/**
 * Auth service — pure functions (no Express types).
 *
 * Covers:
 *  - Password hashing / verification (argon2id)
 *  - Lockout detection (5-strikes in 15 min, BL-005)
 *  - Session creation
 *  - Permission derivation from role
 */

import argon2 from 'argon2';
import { prisma } from '../../lib/prisma.js';
import type { AuthPermissionValue } from '@nexora/contracts/auth';
import { AuthPermission } from '@nexora/contracts/auth';
import type { Role } from '@nexora/contracts/common';

// ── Password ─────────────────────────────────────────────────────────────────

/** Hash a plain-text password with argon2id. */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/** Constant-time comparison of a plain password against a stored hash. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}

// ── Login attempt tracking ────────────────────────────────────────────────────

const LOCKOUT_THRESHOLD = Number(process.env['LOGIN_LOCKOUT_THRESHOLD'] ?? 5);
const LOCKOUT_MINUTES = Number(process.env['LOGIN_LOCKOUT_MINUTES'] ?? 15);

/**
 * Record a login attempt (success or failure).
 * employeeId may be null when the email doesn't match any account.
 */
export async function recordLoginAttempt(params: {
  email: string;
  ip: string;
  success: boolean;
  employeeId?: string | null;
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
 * Create a new session row and return its id.
 * The cookie is set by the route handler — this only writes the DB row.
 */
export async function createSessionFor(params: {
  employeeId: string;
  ip: string;
  userAgent: string | undefined;
  rememberMe: boolean;
}): Promise<{ sessionId: string; expiresAt: Date }> {
  const ttlMs = params.rememberMe
    ? SESSION_REMEMBER_ME_DAYS * 24 * 60 * 60 * 1000
    : SESSION_TTL_HOURS * 60 * 60 * 1000;

  const expiresAt = new Date(Date.now() + ttlMs);

  const session = await prisma.session.create({
    data: {
      employeeId: params.employeeId,
      ip: params.ip,
      userAgent: params.userAgent ?? null,
      expiresAt,
    },
  });

  return { sessionId: session.id, expiresAt };
}

// ── Permissions ───────────────────────────────────────────────────────────────

const ROLE_PERMISSIONS: Record<Role, AuthPermissionValue[]> = {
  Employee: [],
  Manager: [
    AuthPermission.EMPLOYEES_READ,
    AuthPermission.LEAVE_APPROVE,
    AuthPermission.ATTENDANCE_REGULARISE_APPROVE,
  ],
  PayrollOfficer: [
    AuthPermission.EMPLOYEES_READ,
    AuthPermission.PAYROLL_RUN,
    AuthPermission.PAYROLL_FINALISE,
    AuthPermission.PAYROLL_REVERSE,
  ],
  Admin: [
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
 * Derive the permission array for a given role.
 * Used by GET /auth/me to surface fine-grained frontend gating.
 */
export function permissionsFor(role: Role): AuthPermissionValue[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

// ── Token utilities ───────────────────────────────────────────────────────────

import crypto from 'crypto';

/** Generate a cryptographically secure random token (hex). */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** SHA-256 hash of a raw token — what we store in the DB. */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
