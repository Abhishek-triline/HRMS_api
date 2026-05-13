/**
 * Performance Reviews service — v2 schema (INT IDs, INT status codes).
 *
 * Business rules enforced here:
 *   BL-037  Mid-cycle joiners excluded: employeeId joined after fyStart → skip.
 *   BL-038  Goals: Manager creates; Employee proposes during self-review window.
 *   BL-039  Self-rating locked after selfReviewDeadline.
 *   BL-040  Manager-rating deadline + managerOverrodeSelf flag.
 *   BL-041  Cycle closure locks all reviews; CYCLE_CLOSED on subsequent mutations.
 *   BL-042  Manager-change mid-cycle: propagate to open reviews.
 *
 * v2 schema notes:
 *   - All IDs are INT (number).
 *   - PerformanceCycle.status is INT (CycleStatus constants).
 *   - Goal.outcomeId is INT (GoalOutcome constants).
 *   - No isMidCycleJoiner, selfSubmittedAt, managerSubmittedAt on PerformanceReview.
 *   - No participants field on PerformanceCycle.
 *   - PerformanceCycle relations: creator / closer (not createdByEmployee / closedByEmployee).
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notifications.js';
import { ErrorCode, errorEnvelope } from '@nexora/contracts/errors';
import type { ErrorEnvelope } from '@nexora/contracts/errors';
import type { CreateCycleRequest } from '@nexora/contracts/performance';
import {
  CycleStatus,
  GoalOutcome,
  RoleId,
  type AuditActorRoleValue,
} from '../../lib/statusInt.js';

/** Discriminated union for service results. */
export type ServiceError = { error: ErrorEnvelope; status: number };

export function isServiceError(r: { error?: unknown; status?: unknown } | unknown): r is ServiceError {
  return typeof r === 'object' && r !== null && 'error' in (r as object);
}

// ── Cycle code generator ─────────────────────────────────────────────────────

/**
 * Derive cycle code from fyStart date.
 * April 1 – September 30 → H1 (year = calendar year of fyStart)
 * October 1 – March 31   → H2 (year = calendar year of fyStart)
 */
export function generateCycleCode(fyStart: Date): string {
  const month = fyStart.getUTCMonth() + 1; // 1-indexed
  const year = fyStart.getUTCFullYear();
  const half = month >= 4 && month <= 9 ? 'H1' : 'H2';
  return `C-${year}-${half}`;
}

// ── Row shapes ───────────────────────────────────────────────────────────────

type CycleWithRelations = Prisma.PerformanceCycleGetPayload<{
  include: {
    creator: { select: { name: true } };
    closer: { select: { name: true } };
  };
}>;

type ReviewWithRelations = Prisma.PerformanceReviewGetPayload<{
  include: {
    cycle: {
      select: {
        code: true;
        status: true;
        fyStart: true;
        fyEnd: true;
        selfReviewDeadline: true;
        managerReviewDeadline: true;
      };
    };
    employee: {
      select: {
        name: true;
        code: true;
        department: { select: { name: true } };
        designation: { select: { name: true } };
      };
    };
    manager: { select: { name: true } };
    previousManager: { select: { name: true } };
    goals: true;
  };
}>;

// ── Shape helpers ────────────────────────────────────────────────────────────

export function shapeCycle(row: CycleWithRelations) {
  return {
    id: row.id,
    code: row.code,
    fyStart: row.fyStart.toISOString().split('T')[0]!,
    fyEnd: row.fyEnd.toISOString().split('T')[0]!,
    status: row.status,
    selfReviewDeadline: row.selfReviewDeadline.toISOString().split('T')[0]!,
    managerReviewDeadline: row.managerReviewDeadline.toISOString().split('T')[0]!,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closedBy: row.closedBy ?? null,
    closedByName: row.closer?.name ?? null,
    createdBy: row.createdBy,
    createdByName: row.creator.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

export function shapeReviewSummary(row: ReviewWithRelations) {
  return {
    id: row.id,
    cycleId: row.cycleId,
    cycleCode: row.cycle.code,
    employeeId: row.employeeId,
    employeeName: row.employee.name,
    employeeCode: row.employee.code,
    managerId: row.managerId ?? null,
    managerName: row.manager?.name ?? null,
    selfRating: row.selfRating ?? null,
    managerRating: row.managerRating ?? null,
    managerOverrodeSelf: row.managerOverrodeSelf,
    finalRating: row.finalRating ?? null,
    department: row.employee.department?.name ?? null,
    designation: row.employee.designation?.name ?? null,
  };
}

export function shapeReviewDetail(row: ReviewWithRelations) {
  return {
    id: row.id,
    cycleId: row.cycleId,
    cycleCode: row.cycle.code,
    cycleStatus: row.cycle.status,
    employeeId: row.employeeId,
    employeeName: row.employee.name,
    employeeCode: row.employee.code,
    managerId: row.managerId ?? null,
    managerName: row.manager?.name ?? null,
    previousManagerId: row.previousManagerId ?? null,
    previousManagerName: row.previousManager?.name ?? null,
    goals: row.goals.map((g) => ({
      id: g.id,
      reviewId: g.reviewId,
      text: g.text,
      outcomeId: g.outcomeId,
      proposedByEmployee: g.proposedByEmployee,
      createdAt: g.createdAt.toISOString(),
      version: g.version,
    })),
    selfRating: row.selfRating ?? null,
    selfNote: row.selfNote ?? null,
    managerRating: row.managerRating ?? null,
    managerNote: row.managerNote ?? null,
    managerOverrodeSelf: row.managerOverrodeSelf,
    finalRating: row.finalRating ?? null,
    lockedAt: row.lockedAt ? row.lockedAt.toISOString() : null,
    department: row.employee.department?.name ?? null,
    designation: row.employee.designation?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

// ── include blocks ───────────────────────────────────────────────────────────

export const cycleInclude = {
  creator: { select: { name: true } },
  closer: { select: { name: true } },
} as const satisfies Prisma.PerformanceCycleInclude;

export const reviewInclude = {
  cycle: {
    select: {
      code: true,
      status: true,
      fyStart: true,
      fyEnd: true,
      selfReviewDeadline: true,
      managerReviewDeadline: true,
    },
  },
  employee: {
    select: {
      name: true,
      code: true,
      department: { select: { name: true } },
      designation: { select: { name: true } },
    },
  },
  manager: { select: { name: true } },
  previousManager: { select: { name: true } },
  goals: true,
} as const satisfies Prisma.PerformanceReviewInclude;

// ── createCycle ──────────────────────────────────────────────────────────────

export async function createCycle(
  input: CreateCycleRequest,
  actorId: number,
  actorRole: AuditActorRoleValue,
  actorIp: string | null,
  tx: Prisma.TransactionClient,
) {
  const fyStart = new Date(input.fyStart);
  const fyEnd = new Date(input.fyEnd);
  const selfDeadline = new Date(input.selfReviewDeadline);
  const managerDeadline = new Date(input.managerReviewDeadline);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Validate dates
  if (fyStart >= fyEnd) {
    return {
      error: errorEnvelope(
        ErrorCode.INVALID_DATE_RANGE,
        'fyStart must be before fyEnd.',
        { details: { fyStart: ['Must be before fyEnd.'] } },
      ),
      status: 400,
    };
  }

  if (selfDeadline < fyStart || selfDeadline > fyEnd) {
    return {
      error: errorEnvelope(
        ErrorCode.VALIDATION_FAILED,
        'selfReviewDeadline must fall within [fyStart, fyEnd].',
        { details: { selfReviewDeadline: ['Must be within the cycle window.'] } },
      ),
      status: 400,
    };
  }

  if (managerDeadline < fyStart || managerDeadline > fyEnd) {
    return {
      error: errorEnvelope(
        ErrorCode.VALIDATION_FAILED,
        'managerReviewDeadline must fall within [fyStart, fyEnd].',
        { details: { managerReviewDeadline: ['Must be within the cycle window.'] } },
      ),
      status: 400,
    };
  }

  // Generate code — derive from fyStart; check uniqueness
  const code = generateCycleCode(fyStart);
  const existing = await tx.performanceCycle.findUnique({ where: { code } });
  if (existing) {
    return {
      error: errorEnvelope(
        ErrorCode.VALIDATION_FAILED,
        `A cycle for ${code} already exists (id: ${existing.id}).`,
        { details: { code: ['Cycle code already exists.'] } },
      ),
      status: 409,
    };
  }

  // Identify participants: Active employees whose joinDate <= fyStart (BL-037)
  const participants = await tx.employee.findMany({
    where: {
      status: 1, // EmployeeStatus.Active
      joinDate: { lte: fyStart },
    },
    select: {
      id: true,
      name: true,
      roleId: true,
      reportingManagerId: true,
    },
  });

  // Mid-cycle joiners: Active employees who joined AFTER fyStart but before or on today
  const midCycleJoiners = await tx.employee.findMany({
    where: {
      status: 1, // EmployeeStatus.Active
      joinDate: { gt: fyStart, lte: today },
    },
    select: {
      id: true,
      name: true,
    },
  });

  // Create the cycle
  const cycle = await tx.performanceCycle.create({
    data: {
      code,
      fyStart,
      fyEnd,
      status: CycleStatus.Open,
      selfReviewDeadline: selfDeadline,
      managerReviewDeadline: managerDeadline,
      createdBy: actorId,
      version: 0,
    },
    include: cycleInclude,
  });

  // Build adminPeerReviewers lookup (Option B) — keys are number strings
  const peerMap: Record<string, number> = input.adminPeerReviewers ?? {};

  // Create review rows for participants
  for (const emp of participants) {
    let managerId: number | null = null;

    if (emp.roleId === RoleId.Admin) {
      // Option B: Admin peer review — look up the peer from the map
      const peerId = peerMap[String(emp.id)];
      if (peerId !== undefined) {
        // Validate the peer is an Active Admin
        const peer = await tx.employee.findFirst({
          where: { id: peerId, roleId: RoleId.Admin, status: 1 },
          select: { id: true },
        });
        managerId = peer ? peer.id : null;
      }
      // If not in map or peer not found → managerId stays null (surfaces in missing-reviews)
    } else {
      // Non-admin: use reportingManagerId (may be null)
      managerId = emp.reportingManagerId ?? null;
    }

    await tx.performanceReview.create({
      data: {
        cycleId: cycle.id,
        employeeId: emp.id,
        managerId,
        version: 0,
      },
    });
  }

  // Create review rows for mid-cycle joiners (managerId=null)
  for (const emp of midCycleJoiners) {
    await tx.performanceReview.create({
      data: {
        cycleId: cycle.id,
        employeeId: emp.id,
        managerId: null,
        version: 0,
      },
    });
  }

  // Audit
  await audit({
    tx,
    actorId,
    actorRole,
    actorIp,
    action: 'performance.cycle.create',
    targetType: 'PerformanceCycle',
    targetId: cycle.id,
    module: 'performance',
    before: null,
    after: {
      code: cycle.code,
      fyStart: input.fyStart,
      fyEnd: input.fyEnd,
      participants: participants.length,
      midCycleJoiners: midCycleJoiners.length,
    },
  });

  // Notify each participant about the new cycle and their self-review deadline.
  if (participants.length > 0) {
    const reviews = await tx.performanceReview.findMany({
      where: { cycleId: cycle.id },
      select: { id: true, employeeId: true },
    });
    const reviewByEmployee = new Map(reviews.map((r) => [r.employeeId, r.id]));
    const selfDeadlineStr = selfDeadline.toISOString().split('T')[0];

    for (const emp of participants) {
      const reviewId = reviewByEmployee.get(emp.id);
      await notify({
        tx,
        recipientIds: emp.id,
        category: 'Performance',
        title: `Performance cycle ${cycle.code} is open — self-review due by ${selfDeadlineStr}`,
        body: `A new performance cycle (${cycle.code}) has been opened. Please complete your self-review by ${selfDeadlineStr}.`,
        link: reviewId ? `/employee/performance/${reviewId}` : '/employee/performance',
      });
    }
  }

  return {
    data: {
      cycle: shapeCycle(cycle),
      reviewCount: participants.length,
      skipped: midCycleJoiners.map((e) => ({
        employeeId: e.id,
        employeeName: e.name,
        reason: 'MidCycleJoiner' as const,
      })),
    },
  };
}

// ── closeCycle ───────────────────────────────────────────────────────────────

export async function closeCycle(
  cycleId: number,
  expectedVersion: number,
  actorId: number,
  actorRole: AuditActorRoleValue,
  actorIp: string | null,
  tx: Prisma.TransactionClient,
) {
  const cycle = await tx.performanceCycle.findUnique({
    where: { id: cycleId },
    include: cycleInclude,
  });

  if (!cycle) {
    return { error: errorEnvelope(ErrorCode.NOT_FOUND, 'Cycle not found.'), status: 404 };
  }

  if (cycle.status === CycleStatus.Closed) {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_CLOSED,
        'This performance cycle is already closed.',
        { ruleId: 'BL-041' },
      ),
      status: 409,
    };
  }

  if (cycle.version !== expectedVersion) {
    return {
      error: errorEnvelope(
        ErrorCode.VERSION_MISMATCH,
        'Cycle has been modified by another user. Reload and retry.',
        { details: { expectedVersion, actualVersion: cycle.version } },
      ),
      status: 409,
    };
  }

  const now = new Date();

  // Lock all reviews: set finalRating = managerRating (or null), lockedAt = now
  const reviews = await tx.performanceReview.findMany({
    where: { cycleId },
    select: { id: true, managerRating: true },
  });

  let lockedReviews = 0;
  for (const r of reviews) {
    await tx.performanceReview.update({
      where: { id: r.id },
      data: {
        finalRating: r.managerRating ?? null,
        lockedAt: now,
        version: { increment: 1 },
      },
    });
    lockedReviews++;
  }

  // Close the cycle
  const updated = await tx.performanceCycle.update({
    where: { id: cycleId },
    data: {
      status: CycleStatus.Closed,
      closedAt: now,
      closedBy: actorId,
      version: { increment: 1 },
    },
    include: cycleInclude,
  });

  await audit({
    tx,
    actorId,
    actorRole,
    actorIp,
    action: 'performance.cycle.close',
    targetType: 'PerformanceCycle',
    targetId: cycleId,
    module: 'performance',
    before: { status: cycle.status, version: cycle.version },
    after: { status: CycleStatus.Closed, closedAt: now.toISOString(), lockedReviews },
  });

  // Notify all participants that the cycle is closed
  const participantReviews = await tx.performanceReview.findMany({
    where: { cycleId },
    select: { employeeId: true },
  });
  const participantIds = Array.from(new Set(participantReviews.map((r) => r.employeeId)));
  if (participantIds.length > 0) {
    await notify({
      tx,
      recipientIds: participantIds,
      category: 'Performance',
      title: `Performance cycle ${updated.code} is closed`,
      body: `The performance cycle ${updated.code} has been closed. Final ratings have been locked.`,
      link: '/employee/performance',
    });
  }

  return { data: { cycle: shapeCycle(updated), lockedReviews } };
}

// ── createGoal ───────────────────────────────────────────────────────────────

export async function createGoal(
  reviewId: number,
  text: string,
  actorId: number,
  actorRole: AuditActorRoleValue,
  actorIp: string | null,
  tx: Prisma.TransactionClient,
) {
  const review = await tx.performanceReview.findUnique({
    where: { id: reviewId },
    include: { cycle: true },
  });

  if (!review) {
    return { error: errorEnvelope(ErrorCode.NOT_FOUND, 'Review not found.'), status: 404 };
  }

  if (review.cycle.status === CycleStatus.Closed) {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_CLOSED,
        'Cannot add goals to a closed cycle.',
        { ruleId: 'BL-041' },
      ),
      status: 409,
    };
  }

  // Only the assigned manager or Admin may create goals
  if (actorRole !== RoleId.Admin && review.managerId !== actorId) {
    return {
      error: errorEnvelope(
        ErrorCode.FORBIDDEN,
        'Only the assigned manager or an Admin may create goals.',
      ),
      status: 403,
    };
  }

  // Cap at 20 goals
  const goalCount = await tx.goal.count({ where: { reviewId } });
  if (goalCount >= 20) {
    return {
      error: errorEnvelope(
        ErrorCode.VALIDATION_FAILED,
        'A review may have at most 20 goals.',
        { details: { goals: ['Limit of 20 goals per review reached.'] } },
      ),
      status: 400,
    };
  }

  const goal = await tx.goal.create({
    data: {
      reviewId,
      text,
      outcomeId: GoalOutcome.Pending,
      proposedByEmployee: false,
      version: 0,
    },
  });

  await audit({
    tx,
    actorId,
    actorRole,
    actorIp,
    action: 'performance.goal.create',
    targetType: 'Goal',
    targetId: goal.id,
    module: 'performance',
    before: null,
    after: { reviewId, text, outcomeId: GoalOutcome.Pending, proposedByEmployee: false },
  });

  return {
    data: {
      goal: {
        id: goal.id,
        reviewId: goal.reviewId,
        text: goal.text,
        outcomeId: goal.outcomeId,
        proposedByEmployee: goal.proposedByEmployee,
        createdAt: goal.createdAt.toISOString(),
        version: goal.version,
      },
    },
  };
}

// ── proposeGoal ──────────────────────────────────────────────────────────────

export async function proposeGoal(
  reviewId: number,
  text: string,
  actorId: number,
  actorRole: AuditActorRoleValue,
  actorIp: string | null,
  tx: Prisma.TransactionClient,
) {
  const review = await tx.performanceReview.findUnique({
    where: { id: reviewId },
    include: { cycle: true },
  });

  if (!review) {
    return { error: errorEnvelope(ErrorCode.NOT_FOUND, 'Review not found.'), status: 404 };
  }

  // Only the employee who owns this review may propose goals
  if (review.employeeId !== actorId) {
    return {
      error: errorEnvelope(
        ErrorCode.FORBIDDEN,
        'Only the review owner may propose goals.',
      ),
      status: 403,
    };
  }

  if (review.cycle.status === CycleStatus.Closed) {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_CLOSED,
        'Cannot propose goals in a closed cycle.',
        { ruleId: 'BL-041' },
      ),
      status: 409,
    };
  }

  // BL-038: Employee may only propose during SelfReview phase or within [fyStart, selfReviewDeadline]
  const now = new Date();
  const selfDeadline = review.cycle.selfReviewDeadline;
  const fyStart = review.cycle.fyStart;

  const inSelfReviewPhase = review.cycle.status === CycleStatus.SelfReview;
  const inSelfWindow = now >= fyStart && now <= selfDeadline;

  if (!inSelfReviewPhase && !inSelfWindow) {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_PHASE,
        'Goals can only be proposed during the self-review window.',
        { ruleId: 'BL-038' },
      ),
      status: 409,
    };
  }

  // Cap at 20 goals
  const goalCount = await tx.goal.count({ where: { reviewId } });
  if (goalCount >= 20) {
    return {
      error: errorEnvelope(
        ErrorCode.VALIDATION_FAILED,
        'A review may have at most 20 goals.',
        { details: { goals: ['Limit of 20 goals per review reached.'] } },
      ),
      status: 400,
    };
  }

  const goal = await tx.goal.create({
    data: {
      reviewId,
      text,
      outcomeId: GoalOutcome.Pending,
      proposedByEmployee: true,
      version: 0,
    },
  });

  await audit({
    tx,
    actorId,
    actorRole,
    actorIp,
    action: 'performance.goal.propose',
    targetType: 'Goal',
    targetId: goal.id,
    module: 'performance',
    before: null,
    after: { reviewId, text, outcomeId: GoalOutcome.Pending, proposedByEmployee: true },
  });

  return {
    data: {
      goal: {
        id: goal.id,
        reviewId: goal.reviewId,
        text: goal.text,
        outcomeId: goal.outcomeId,
        proposedByEmployee: goal.proposedByEmployee,
        createdAt: goal.createdAt.toISOString(),
        version: goal.version,
      },
    },
  };
}

// ── submitSelfRating ─────────────────────────────────────────────────────────

export async function submitSelfRating(
  reviewId: number,
  selfRating: number,
  selfNote: string | undefined,
  expectedVersion: number,
  actorId: number,
  actorRole: AuditActorRoleValue,
  actorIp: string | null,
  tx: Prisma.TransactionClient,
) {
  const review = await tx.performanceReview.findUnique({
    where: { id: reviewId },
    include: reviewInclude,
  });

  if (!review) {
    return { error: errorEnvelope(ErrorCode.NOT_FOUND, 'Review not found.'), status: 404 };
  }

  // Only the employee who owns this review
  if (review.employeeId !== actorId) {
    return {
      error: errorEnvelope(
        ErrorCode.FORBIDDEN,
        'Only the review owner may submit a self-rating.',
      ),
      status: 403,
    };
  }

  if (review.cycle.status === CycleStatus.Closed) {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_CLOSED,
        'Cannot submit self-rating on a closed cycle.',
        { ruleId: 'BL-041' },
      ),
      status: 409,
    };
  }

  // BL-039: must be within [fyStart, selfReviewDeadline]
  const now = new Date();
  const selfDeadline = review.cycle.selfReviewDeadline;
  const fyStart = review.cycle.fyStart;

  if (now < fyStart || now > selfDeadline) {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_PHASE,
        'Self-rating can only be submitted within the self-review window.',
        { ruleId: 'BL-039' },
      ),
      status: 409,
    };
  }

  // Optimistic concurrency
  if (review.version !== expectedVersion) {
    return {
      error: errorEnvelope(
        ErrorCode.VERSION_MISMATCH,
        'Review has been modified by another user. Reload and retry.',
        { details: { expectedVersion, actualVersion: review.version } },
      ),
      status: 409,
    };
  }

  const beforeSnapshot = {
    selfRating: review.selfRating,
    selfNote: review.selfNote,
    version: review.version,
  };

  const updated = await tx.performanceReview.update({
    where: { id: reviewId },
    data: {
      selfRating,
      selfNote: selfNote ?? null,
      version: { increment: 1 },
    },
    include: reviewInclude,
  });

  await audit({
    tx,
    actorId,
    actorRole,
    actorIp,
    action: 'performance.review.self-rating',
    targetType: 'PerformanceReview',
    targetId: reviewId,
    module: 'performance',
    before: beforeSnapshot,
    after: { selfRating, selfNote: selfNote ?? null },
  });

  // Notify the assigned manager that the employee submitted their self-rating
  if (updated.managerId) {
    await notify({
      tx,
      recipientIds: updated.managerId,
      category: 'Performance',
      title: `${updated.employee.name} submitted their self-rating`,
      body: `${updated.employee.name} has submitted their self-rating for performance cycle ${updated.cycle.code}. You can now review and submit your manager rating.`,
      link: `/manager/performance/${reviewId}`,
    });
  }

  return { data: shapeReviewDetail(updated) };
}

// ── submitManagerRating ──────────────────────────────────────────────────────

export async function submitManagerRating(
  reviewId: number,
  managerRating: number,
  managerNote: string | undefined,
  goals: Array<{ id: number; outcomeId: number }> | undefined,
  expectedVersion: number,
  actorId: number,
  actorRole: AuditActorRoleValue,
  actorIp: string | null,
  tx: Prisma.TransactionClient,
) {
  const review = await tx.performanceReview.findUnique({
    where: { id: reviewId },
    include: reviewInclude,
  });

  if (!review) {
    return { error: errorEnvelope(ErrorCode.NOT_FOUND, 'Review not found.'), status: 404 };
  }

  // BL-042: current managerId OR Admin may submit
  if (actorRole !== RoleId.Admin && review.managerId !== actorId) {
    return {
      error: errorEnvelope(
        ErrorCode.FORBIDDEN,
        'Only the assigned manager or an Admin may submit a manager rating.',
        { ruleId: 'BL-042' },
      ),
      status: 403,
    };
  }

  if (review.cycle.status === CycleStatus.Closed) {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_CLOSED,
        'Cannot submit manager rating on a closed cycle.',
        { ruleId: 'BL-041' },
      ),
      status: 409,
    };
  }

  // BL-040: must be within [fyStart, managerReviewDeadline]
  const now = new Date();
  const managerDeadline = review.cycle.managerReviewDeadline;
  const fyStart = review.cycle.fyStart;

  if (now < fyStart || now > managerDeadline) {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_PHASE,
        'Manager rating can only be submitted within the manager-review window.',
        { ruleId: 'BL-040' },
      ),
      status: 409,
    };
  }

  // Optimistic concurrency
  if (review.version !== expectedVersion) {
    return {
      error: errorEnvelope(
        ErrorCode.VERSION_MISMATCH,
        'Review has been modified. Reload and retry.',
        { details: { expectedVersion, actualVersion: review.version } },
      ),
      status: 409,
    };
  }

  // BL-040: managerOverrodeSelf flag
  const managerOverrodeSelf =
    review.selfRating !== null && managerRating !== review.selfRating;

  const beforeSnapshot = {
    managerRating: review.managerRating,
    managerNote: review.managerNote,
    managerOverrodeSelf: review.managerOverrodeSelf,
    version: review.version,
  };

  // Apply goal outcome updates if provided.
  if (goals && goals.length > 0) {
    for (const g of goals) {
      const result = await tx.goal.updateMany({
        where: { id: g.id, reviewId },
        data: {
          outcomeId: g.outcomeId,
          version: { increment: 1 },
        },
      });
      if (result.count === 0) {
        const err = new Error(
          `Goal ${g.id} does not belong to review ${reviewId}.`,
        ) as Error & { statusCode?: number; code?: string };
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }
    }
  }

  const updated = await tx.performanceReview.update({
    where: { id: reviewId },
    data: {
      managerRating,
      managerNote: managerNote ?? null,
      managerOverrodeSelf,
      version: { increment: 1 },
    },
    include: reviewInclude,
  });

  await audit({
    tx,
    actorId,
    actorRole,
    actorIp,
    action: 'performance.review.manager-rating',
    targetType: 'PerformanceReview',
    targetId: reviewId,
    module: 'performance',
    before: beforeSnapshot,
    after: {
      managerRating,
      managerNote: managerNote ?? null,
      managerOverrodeSelf,
      goalsUpdated: goals?.length ?? 0,
    },
  });

  // Notify the employee that their manager has submitted their performance rating
  await notify({
    tx,
    recipientIds: updated.employeeId,
    category: 'Performance',
    title: 'Your manager submitted your performance rating',
    body: `Your manager has submitted your performance rating for cycle ${updated.cycle.code}.`,
    link: `/employee/performance/${reviewId}`,
  });

  return { data: shapeReviewDetail(updated) };
}

// ── handleManagerChange (BL-042) ─────────────────────────────────────────────

/**
 * Called from the reassign-manager handler after the employee record update.
 * Updates every open PerformanceReview for this employee to point to the new manager.
 * Writes a performance.review.manager-change audit entry per review.
 */
export async function handleManagerChange(
  employeeId: number,
  oldManagerId: number | null,
  newManagerId: number | null,
  actorId: number,
  actorRole: AuditActorRoleValue,
  actorIp: string | null,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const activeReviews = await tx.performanceReview.findMany({
    where: {
      employeeId,
      cycle: { status: { not: CycleStatus.Closed } },
    },
    select: { id: true, managerId: true, version: true },
  });

  // Fetch employee name once for notification messages
  const empRow = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { name: true },
  });
  const employeeName = empRow?.name ?? 'An employee';

  // Fetch new manager name for the message
  let newManagerName: string | null = null;
  if (newManagerId) {
    const newMgr = await tx.employee.findUnique({
      where: { id: newManagerId },
      select: { name: true },
    });
    newManagerName = newMgr?.name ?? null;
  }

  for (const r of activeReviews) {
    await tx.performanceReview.update({
      where: { id: r.id },
      data: {
        previousManagerId: r.managerId,
        managerId: newManagerId,
        version: { increment: 1 },
      },
    });

    await audit({
      tx,
      actorId,
      actorRole,
      actorIp,
      action: 'performance.review.manager-change',
      targetType: 'PerformanceReview',
      targetId: r.id,
      module: 'performance',
      before: { managerId: r.managerId },
      after: { managerId: newManagerId, previousManagerId: r.managerId },
    });

    // Notify old manager and new manager about the review reassignment (BL-042)
    const notifyIds = [r.managerId, newManagerId].filter(
      (id): id is number => id !== null && id !== undefined,
    );
    if (notifyIds.length > 0) {
      const reviewedByMsg = newManagerName ? ` to ${newManagerName}` : '';
      await notify({
        tx,
        recipientIds: notifyIds,
        category: 'Performance',
        title: `Performance review for ${employeeName} was reassigned`,
        body: `The performance review for ${employeeName} has been reassigned${reviewedByMsg}.`,
        link: `/manager/performance/${r.id}`,
      });
    }
  }
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

/** Fetch a single cycle with all relations. Returns null if not found. */
export async function fetchCycleById(id: number) {
  return prisma.performanceCycle.findUnique({
    where: { id },
    include: cycleInclude,
  });
}

/** Fetch a single review with all relations. Returns null if not found. */
export async function fetchReviewById(id: number) {
  return prisma.performanceReview.findUnique({
    where: { id },
    include: reviewInclude,
  });
}
