/**
 * Audit log helper — BL-047 / BL-048.
 *
 * EVERY state-changing action MUST call `audit(...)`.
 * The DB enforces append-only via REVOKE UPDATE, DELETE on audit_log
 * (applied in the migration after table creation — BL-047 enforcement point).
 *
 * v2: all IDs are INT auto-increment; module, actor role, and target type
 * are INT codes (HRMS_Schema_v2_Plan §3.9). For ergonomics this helper
 * accepts the string keys (`'auth'`, `'Manager'`, `'LeaveRequest'`) and maps
 * them to INT codes via the frozen constants in `./statusInt.ts`.
 *
 * If `tx` is provided, the write runs inside the caller's transaction.
 * Otherwise a top-level write is used.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import {
  AuditActorRole,
  AuditModuleId,
  AuditTargetType,
  type AuditActorRoleValue,
  type AuditModuleIdValue,
  type AuditTargetTypeValue,
} from './statusInt.js';

export type AuditParams = {
  /** The Prisma transaction client — if supplied, the write joins the caller's tx. */
  tx?: Prisma.TransactionClient;
  /** actorId — null for system-generated events (cron jobs, etc.). INT employee id. */
  actorId: number | null;
  /** Friendly role name OR the INT code. Resolved to actor_role_id. */
  actorRole: keyof typeof AuditActorRole | AuditActorRoleValue;
  actorIp?: string | null;
  /** Dot-separated action name, e.g. "auth.login.success". */
  action: string;
  /** Target entity type — friendly name OR the INT code. */
  targetType?: keyof typeof AuditTargetType | AuditTargetTypeValue | null;
  /** INT target id of the entity. */
  targetId?: number | null;
  /** Module name — must be one of the frozen audit_modules keys. */
  module: keyof typeof AuditModuleId;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

function resolveActorRole(v: AuditParams['actorRole']): AuditActorRoleValue {
  return typeof v === 'number' ? v : AuditActorRole[v];
}

function resolveTargetType(
  v: AuditParams['targetType'],
): AuditTargetTypeValue | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : AuditTargetType[v];
}

/**
 * Write a single append-only audit entry.
 * Throws on failure — never silently swallows errors (notify() is the helper
 * that swallows; audit() is the canonical source of truth).
 */
export async function audit(params: AuditParams): Promise<void> {
  const db = params.tx ?? prisma;

  await db.auditLog.create({
    data: {
      actorId: params.actorId,
      actorRoleId: resolveActorRole(params.actorRole),
      actorIp: params.actorIp ?? null,
      action: params.action,
      targetTypeId: resolveTargetType(params.targetType),
      targetId: params.targetId ?? null,
      moduleId: AuditModuleId[params.module],
      before: (params.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (params.after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
