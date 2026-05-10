/**
 * Performance Reviews service — Phase 5.
 *
 * Business rules enforced here:
 *   BL-037  Mid-cycle joiners excluded from rating; created with isMidCycleJoiner=true.
 *   BL-038  Goals: Manager creates; Employee proposes during self-review window.
 *   BL-039  Self-rating locked after selfReviewDeadline.
 *   BL-040  Manager-rating deadline + managerOverrodeSelf flag.
 *   BL-041  Cycle closure locks all reviews; CYCLE_CLOSED on subsequent mutations.
 *   BL-042  Manager-change mid-cycle: propagate to open reviews.
 *
 * Option B admin self-review (Implementation Plan § 9):
 *   Admins have managerId = peer Admin (from adminPeerReviewers map).
 *   Admins not in the map get managerId=null and surface in missing-reviews.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notifications.js';
import { ErrorCode, errorEnvelope } from '@nexora/contracts/errors';
import type { ErrorEnvelope } from '@nexora/contracts/errors';
import type { CreateCycleRequest } from '@nexora/contracts/performance';

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

// ── DB → Contract status mapping ─────────────────────────────────────────────

/** Map DB enum (no hyphens) → contract enum (with hyphens). */
export function mapCycleStatus(s: string): 'Open' | 'Self-Review' | 'Manager-Review' | 'Closed' {
  const m: Record<string, 'Open' | 'Self-Review' | 'Manager-Review' | 'Closed'> = {
    Open: 'Open',
    SelfReview: 'Self-Review',
    ManagerReview: 'Manager-Review',
    Closed: 'Closed',
  };
  return m[s] ?? 'Open';
}

/** Map contract enum → DB enum. */
export function mapCycleStatusToDB(s: string): 'Open' | 'SelfReview' | 'ManagerReview' | 'Closed' {
  const m: Record<string, 'Open' | 'SelfReview' | 'ManagerReview' | 'Closed'> = {
    'Open': 'Open',
    'Self-Review': 'SelfReview',
    'Manager-Review': 'ManagerReview',
    'Closed': 'Closed',
  };
  return m[s] ?? 'Open';
}

/** Map DB goal outcome → contract outcome. */
export function mapGoalOutcome(s: string): 'Met' | 'Partial' | 'Missed' | 'Pending' {
  const m: Record<string, 'Met' | 'Partial' | 'Missed' | 'Pending'> = {
    Met: 'Met',
    Partial: 'Partial',
    Missed: 'Missed',
    Pending: 'Pending',
  };
  return m[s] ?? 'Pending';
}

/** Map contract goal outcome → DB enum. */
export function mapGoalOutcomeToDB(s: string): 'Met' | 'Partial' | 'Missed' | 'Pending' {
  return mapGoalOutcome(s);
}

// ── Row shapes ───────────────────────────────────────────────────────────────

type CycleWithRelations = Prisma.PerformanceCycleGetPayload<{
  include: {
    createdByEmployee: { select: { name: true } };
    closedByEmployee: { select: { name: true } };
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
    employee: { select: { name: true; code: true; department: true; designation: true } };
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
    status: mapCycleStatus(row.status),
    selfReviewDeadline: row.selfReviewDeadline.toISOString().split('T')[0]!,
    managerReviewDeadline: row.managerReviewDeadline.toISOString().split('T')[0]!,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closedBy: row.closedBy ?? null,
    closedByName: row.closedByEmployee?.name ?? null,
    createdBy: row.createdBy,
    createdByName: row.createdByEmployee.name,
    participants: row.participants,
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
    isMidCycleJoiner: row.isMidCycleJoiner,
    department: row.employee.department ?? null,
    designation: row.employee.designation ?? null,
  };
}

export function shapeReviewDetail(row: ReviewWithRelations) {
  return {
    id: row.id,
    cycleId: row.cycleId,
    cycleCode: row.cycle.code,
    cycleStatus: mapCycleStatus(row.cycle.status),
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
      outcome: mapGoalOutcome(g.outcome),
      proposedByEmployee: g.proposedByEmployee,
      createdAt: g.createdAt.toISOString(),
      version: g.version,
    })),
    selfRating: row.selfRating ?? null,
    selfNote: row.selfNote ?? null,
    selfSubmittedAt: row.selfSubmittedAt ? row.selfSubmittedAt.toISOString() : null,
    managerRating: row.managerRating ?? null,
    managerNote: row.managerNote ?? null,
    managerSubmittedAt: row.managerSubmittedAt ? row.managerSubmittedAt.toISOString() : null,
    managerOverrodeSelf: row.managerOverrodeSelf,
    finalRating: row.finalRating ?? null,
    lockedAt: row.lockedAt ? row.lockedAt.toISOString() : null,
    isMidCycleJoiner: row.isMidCycleJoiner,
    department: row.employee.department ?? null,
    designation: row.employee.designation ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

// ── include blocks ───────────────────────────────────────────────────────────

export const cycleInclude = {
  createdByEmployee: { select: { name: true } },
  closedByEmployee: { select: { name: true } },
} as const;

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
  employee: { select: { name: true, code: true, department: true, designation: true } },
  manager: { select: { name: true } },
  previousManager: { select: { name: true } },
  goals: true,
} as const;

// ── createCycle ──────────────────────────────────────────────────────────────

export async function createCycle(
  input: CreateCycleRequest,
  actorId: string,
  actorRole: string,
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
      status: 'Active',
      joinDate: { lte: fyStart },
    },
    select: {
      id: true,
      name: true,
      role: true,
      reportingManagerId: true,
    },
  });

  // Mid-cycle joiners: Active employees who joined AFTER fyStart but before or on today
  const midCycleJoiners = await tx.employee.findMany({
    where: {
      status: 'Active',
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
      status: 'Open',
      selfReviewDeadline: selfDeadline,
      managerReviewDeadline: managerDeadline,
      createdBy: actorId,
      participants: participants.length,
      version: 0,
    },
    include: cycleInclude,
  });

  // Build adminPeerReviewers lookup (Option B)
  const peerMap: Record<string, string> = input.adminPeerReviewers ?? {};

  // Create review rows for participants
  for (const emp of participants) {
    let managerId: string | null = null;

    if (emp.role === 'Admin') {
      // Option B: Admin peer review — look up the peer from the map
      const peerId = peerMap[emp.id];
      if (peerId) {
        // Validate the peer is an Active Admin
        const peer = await tx.employee.findFirst({
          where: { id: peerId, role: 'Admin', status: 'Active' },
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
        isMidCycleJoiner: false,
        version: 0,
      },
    });
  }

  // Create review rows for mid-cycle joiners (isMidCycleJoiner=true, managerId=null)
  for (const emp of midCycleJoiners) {
    await tx.performanceReview.create({
      data: {
        cycleId: cycle.id,
        employeeId: emp.id,
        managerId: null,
        isMidCycleJoiner: true,
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

  // Notify each participant (not mid-cycle joiners) about the new cycle
  // and their self-review deadline. Fetch review IDs for per-employee links.
  if (participants.length > 0) {
    const reviews = await tx.performanceReview.findMany({
      where: { cycleId: cycle.id, isMidCycleJoiner: false },
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
  cycleId: string,
  expectedVersion: number,
  actorId: string,
  actorRole: string,
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

  if (cycle.status === 'Closed') {
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
      status: 'Closed',
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
    before: { status: mapCycleStatus(cycle.status), version: cycle.version },
    after: { status: 'Closed', closedAt: now.toISOString(), lockedReviews },
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
  reviewId: string,
  text: string,
  actorId: string,
  actorRole: string,
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

  if (review.cycle.status === 'Closed') {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_CLOSED,
        'Cannot add goals to a closed cycle.',
        { ruleId: 'BL-041' },
      ),
      status: 409,
    };
  }

  // Mid-cycle joiners are skipped (BL-037)
  if (review.isMidCycleJoiner) {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_PHASE,
        'This employee is a mid-cycle joiner and is excluded from this cycle.',
        { ruleId: 'BL-037' },
      ),
      status: 409,
    };
  }

  // Only the assigned manager or Admin may create goals
  if (actorRole !== 'Admin' && review.managerId !== actorId) {
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
      outcome: 'Pending',
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
    after: { reviewId, text, outcome: 'Pending', proposedByEmployee: false },
  });

  return {
    data: {
      goal: {
        id: goal.id,
        reviewId: goal.reviewId,
        text: goal.text,
        outcome: mapGoalOutcome(goal.outcome) as 'Met' | 'Partial' | 'Missed' | 'Pending',
        proposedByEmployee: goal.proposedByEmployee,
        createdAt: goal.createdAt.toISOString(),
        version: goal.version,
      },
    },
  };
}

// ── proposeGoal ──────────────────────────────────────────────────────────────

export async function proposeGoal(
  reviewId: string,
  text: string,
  actorId: string,
  actorRole: string,
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

  if (review.cycle.status === 'Closed') {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_CLOSED,
        'Cannot propose goals in a closed cycle.',
        { ruleId: 'BL-041' },
      ),
      status: 409,
    };
  }

  // Mid-cycle joiners are excluded (BL-037)
  if (review.isMidCycleJoiner) {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_PHASE,
        'Mid-cycle joiners are excluded from this cycle.',
        { ruleId: 'BL-037' },
      ),
      status: 409,
    };
  }

  // BL-038: Employee may only propose during SelfReview phase or within [fyStart, selfReviewDeadline]
  const now = new Date();
  const selfDeadline = review.cycle.selfReviewDeadline;
  const fyStart = review.cycle.fyStart;

  const inSelfReviewPhase = review.cycle.status === 'SelfReview';
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
      outcome: 'Pending',
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
    after: { reviewId, text, outcome: 'Pending', proposedByEmployee: true },
  });

  return {
    data: {
      goal: {
        id: goal.id,
        reviewId: goal.reviewId,
        text: goal.text,
        outcome: mapGoalOutcome(goal.outcome) as 'Met' | 'Partial' | 'Missed' | 'Pending',
        proposedByEmployee: goal.proposedByEmployee,
        createdAt: goal.createdAt.toISOString(),
        version: goal.version,
      },
    },
  };
}

// ── submitSelfRating ─────────────────────────────────────────────────────────

export async function submitSelfRating(
  reviewId: string,
  selfRating: number,
  selfNote: string | undefined,
  expectedVersion: number,
  actorId: string,
  actorRole: string,
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

  if (review.cycle.status === 'Closed') {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_CLOSED,
        'Cannot submit self-rating on a closed cycle.',
        { ruleId: 'BL-041' },
      ),
      status: 409,
    };
  }

  // Mid-cycle joiners excluded (BL-037)
  if (review.isMidCycleJoiner) {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_PHASE,
        'Mid-cycle joiners are excluded from this cycle.',
        { ruleId: 'BL-037' },
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
    selfSubmittedAt: review.selfSubmittedAt,
    version: review.version,
  };

  const updated = await tx.performanceReview.update({
    where: { id: reviewId },
    data: {
      selfRating,
      selfNote: selfNote ?? null,
      selfSubmittedAt: now,
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
    after: { selfRating, selfNote: selfNote ?? null, selfSubmittedAt: now.toISOString() },
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
  reviewId: string,
  managerRating: number,
  managerNote: string | undefined,
  goals: Array<{ id: string; outcome: string }> | undefined,
  expectedVersion: number,
  actorId: string,
  actorRole: string,
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
  if (actorRole !== 'Admin' && review.managerId !== actorId) {
    return {
      error: errorEnvelope(
        ErrorCode.FORBIDDEN,
        'Only the assigned manager or an Admin may submit a manager rating.',
        { ruleId: 'BL-042' },
      ),
      status: 403,
    };
  }

  if (review.cycle.status === 'Closed') {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_CLOSED,
        'Cannot submit manager rating on a closed cycle.',
        { ruleId: 'BL-041' },
      ),
      status: 409,
    };
  }

  // Mid-cycle joiners excluded (BL-037)
  if (review.isMidCycleJoiner) {
    return {
      error: errorEnvelope(
        ErrorCode.CYCLE_PHASE,
        'Mid-cycle joiners are excluded from this cycle.',
        { ruleId: 'BL-037' },
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
    managerSubmittedAt: review.managerSubmittedAt,
    managerOverrodeSelf: review.managerOverrodeSelf,
    version: review.version,
  };

  // Apply goal outcome updates if provided.
  // SEC-002-P5 fix — every goal update is constrained to THIS review.
  // Without the `reviewId` clause a malicious manager could pass goal IDs
  // from a different review they have access to and falsify outcomes on
  // a colleague's record. `updateMany` returns count=0 when the goal
  // doesn't belong to this review; we treat that as a hard error.
  if (goals && goals.length > 0) {
    for (const g of goals) {
      const result = await tx.goal.updateMany({
        where: { id: g.id, reviewId },
        data: {
          outcome: mapGoalOutcomeToDB(g.outcome),
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
      managerSubmittedAt: now,
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
      managerSubmittedAt: now.toISOString(),
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
 * Called from the reassign-manager handler (Phase 1) after the employee record
 * update. Updates every open PerformanceReview for this employee to point to the
 * new manager. Writes a performance.review.manager-change audit entry per review.
 */
export async function handleManagerChange(
  employeeId: string,
  oldManagerId: string | null,
  newManagerId: string | null,
  actorId: string,
  actorRole: string,
  actorIp: string | null,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const activeReviews = await tx.performanceReview.findMany({
    where: {
      employeeId,
      cycle: { status: { not: 'Closed' } },
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
      (id): id is string => id !== null && id !== undefined,
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
export async function fetchCycleById(id: string) {
  return prisma.performanceCycle.findUnique({
    where: { id },
    include: cycleInclude,
  });
}

/** Fetch a single review with all relations. Returns null if not found. */
export async function fetchReviewById(id: string) {
  return prisma.performanceReview.findUnique({
    where: { id },
    include: reviewInclude,
  });
}
