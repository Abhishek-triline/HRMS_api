/**
 * Performance Cycles & Reviews router — mounted at /api/v1/performance.
 *
 * Endpoints (docs/HRMS_API.md § 9):
 *   POST   /cycles                               A-20   Admin
 *   GET    /cycles                               A-20 / M-09 / E-10  Any session
 *   GET    /cycles/:id                           A-21   Admin full; Mgr team; Emp own
 *   POST   /cycles/:id/close                     A-20   Admin
 *   GET    /cycles/:id/reports/distribution      A-22   Admin
 *   GET    /cycles/:id/reports/missing           A-23   Admin
 *   GET    /reviews                              A-21 / M-09 / E-10
 *   GET    /reviews/:id                          E-10 / E-11
 *   POST   /reviews/:id/goals                    M-09   Manager or Admin
 *   POST   /reviews/:id/goals/propose            E-11   Employee (owner)
 *   PATCH  /reviews/:id/self-rating              E-11   Employee (owner)
 *   POST   /reviews/:id/manager-rating           M-10   Manager or Admin
 *
 * Business rules enforced:
 *   BL-038  Goal proposal window (SelfReview phase or within deadline)
 *   BL-039  Self-rating deadline
 *   BL-040  Manager-rating deadline + managerOverrodeSelf
 *   BL-041  Cycle closure — CYCLE_CLOSED on subsequent mutations
 *   BL-042  Manager-change propagation (in employees.routes.ts)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  CreateCycleRequestSchema,
  CloseCycleRequestSchema,
  CreateGoalRequestSchema,
  ProposeGoalRequestSchema,
  SelfRatingRequestSchema,
  ManagerRatingRequestSchema,
  CycleListQuerySchema,
  ReviewListQuerySchema,
} from '@nexora/contracts/performance';
import type {
  CreateCycleRequest,
  CloseCycleRequest,
  CreateGoalRequest,
  ProposeGoalRequest,
  SelfRatingRequest,
  ManagerRatingRequest,
  CycleListQuery,
  ReviewListQuery,
  DistributionBucket,
  MissingReviewItem,
} from '@nexora/contracts/performance';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import { requireSession } from '../../middleware/requireSession.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validateBody.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { idempotencyKey } from '../../middleware/idempotencyKey.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { getSubordinateIds } from '../employees/hierarchy.js';
import {
  RoleId,
  CycleStatus,
  type AuditActorRoleValue,
} from '../../lib/statusInt.js';
import {
  createCycle,
  closeCycle,
  createGoal,
  proposeGoal,
  submitSelfRating,
  submitManagerRating,
  shapeCycle,
  shapeReviewSummary,
  shapeReviewDetail,
  cycleInclude,
  reviewInclude,
  isServiceError,
} from './performance.service.js';

const router = Router();

/** Extract client IP from request. */
function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

// ── POST /cycles ──────────────────────────────────────────────────────────────
// Create a new performance cycle (Admin only). Idempotent.

router.post(
  '/cycles',
  requireSession(),
  requireRole(RoleId.Admin),
  idempotencyKey(),
  validateBody(CreateCycleRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateCycleRequest;
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      const result = await prisma.$transaction(async (tx) => {
        return createCycle(body, actor.id, actor.roleId as AuditActorRoleValue, ip, tx);
      });

      if (isServiceError(result)) {
        res.status(result.status).json(result.error);
        return;
      }

      res.status(201).json(result);
    } catch (err: unknown) {
      logger.error({ err }, 'performance.cycles.create.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to create cycle.'));
    }
  },
);

// ── GET /cycles ───────────────────────────────────────────────────────────────
// List performance cycles. All authenticated users.

router.get(
  '/cycles',
  requireSession(),
  validateQuery(CycleListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as CycleListQuery;

    try {
      const limit = Number(query.limit ?? 20);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: Record<string, any> = {};

      if (query.status) {
        // query.status is already an INT from the contract (z.coerce.number)
        where['status'] = query.status;
      }

      if (query.fyStartFrom || query.fyStartTo) {
        where['fyStart'] = {
          ...(query.fyStartFrom ? { gte: new Date(query.fyStartFrom) } : {}),
          ...(query.fyStartTo ? { lte: new Date(query.fyStartTo) } : {}),
        };
      }

      if (query.cursor) {
        const cursorId = Number(query.cursor);
        if (!isNaN(cursorId)) {
          const cursorRow = await prisma.performanceCycle.findUnique({
            where: { id: cursorId },
            select: { createdAt: true },
          });
          if (cursorRow) {
            where['createdAt'] = { lt: cursorRow.createdAt };
          }
        }
      }

      const cycles = await prisma.performanceCycle.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
      });

      const hasNext = cycles.length > limit;
      const items = hasNext ? cycles.slice(0, limit) : cycles;
      const nextCursor = hasNext ? String(items[items.length - 1]!.id) : null;

      // Per-page review stats: groupBy + counts in one query each.
      // Limited to the visible page, so cost stays O(pageSize × few aggregates).
      const cycleIds = items.map((c) => c.id);
      const reviewsForPage = cycleIds.length
        ? await prisma.performanceReview.findMany({
            where: { cycleId: { in: cycleIds } },
            select: {
              cycleId: true,
              selfRating: true,
              managerRating: true,
              finalRating: true,
            },
          })
        : [];

      const byCycle = new Map<number, {
        participants: number;
        selfSubmitted: number;
        managerSubmitted: number;
        finalised: number;
        finalRatingSum: number;
      }>();
      for (const r of reviewsForPage) {
        const acc = byCycle.get(r.cycleId) ?? {
          participants: 0,
          selfSubmitted: 0,
          managerSubmitted: 0,
          finalised: 0,
          finalRatingSum: 0,
        };
        acc.participants += 1;
        if (r.selfRating !== null) acc.selfSubmitted += 1;
        if (r.managerRating !== null) acc.managerSubmitted += 1;
        if (r.finalRating !== null) {
          acc.finalised += 1;
          acc.finalRatingSum += r.finalRating;
        }
        byCycle.set(r.cycleId, acc);
      }

      const data = items.map((c) => {
        const stats = byCycle.get(c.id);
        const participants = stats?.participants ?? 0;
        const finalised = stats?.finalised ?? 0;
        const avgFinalRating = finalised > 0
          ? Number((stats!.finalRatingSum / finalised).toFixed(2))
          : null;
        return {
          id: c.id,
          code: c.code,
          fyStart: c.fyStart.toISOString().split('T')[0]!,
          fyEnd: c.fyEnd.toISOString().split('T')[0]!,
          status: c.status,
          selfReviewDeadline: c.selfReviewDeadline.toISOString().split('T')[0]!,
          managerReviewDeadline: c.managerReviewDeadline.toISOString().split('T')[0]!,
          closedAt: c.closedAt ? c.closedAt.toISOString() : null,
          participants,
          selfSubmitted: stats?.selfSubmitted ?? 0,
          managerSubmitted: stats?.managerSubmitted ?? 0,
          finalised,
          avgFinalRating,
        };
      });

      res.status(200).json({ data, nextCursor });
    } catch (err: unknown) {
      logger.error({ err }, 'performance.cycles.list.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to list cycles.'));
    }
  },
);

// ── GET /cycles/:id ───────────────────────────────────────────────────────────
// Get cycle detail with scoped reviews.

router.get(
  '/cycles/:id',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const cycleId = Number(req.params['id']);
    if (isNaN(cycleId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Cycle not found.'));
      return;
    }
    const actor = req.user!;

    try {
      const cycle = await prisma.performanceCycle.findUnique({
        where: { id: cycleId },
        include: cycleInclude,
      });

      if (!cycle) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Cycle not found.'));
        return;
      }

      // Build review filter based on role
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let reviewWhere: Record<string, any> = { cycleId };

      if (actor.roleId === RoleId.Manager) {
        // Manager sees reviews where they are the assigned manager OR their subordinates
        const subIds = await getSubordinateIds(actor.id);
        reviewWhere = {
          cycleId,
          OR: [
            { managerId: actor.id },
            { employeeId: { in: subIds } },
          ],
        };
      } else if (actor.roleId === RoleId.Employee || actor.roleId === RoleId.PayrollOfficer) {
        // Employee sees only own review
        reviewWhere = { cycleId, employeeId: actor.id };
      }
      // Admin: no additional filter

      const reviews = await prisma.performanceReview.findMany({
        where: reviewWhere,
        include: reviewInclude,
        orderBy: { createdAt: 'asc' },
      });

      res.status(200).json({
        data: {
          cycle: shapeCycle(cycle),
          reviews: reviews.map((r) => shapeReviewSummary(r)),
        },
      });
    } catch (err: unknown) {
      logger.error({ err }, 'performance.cycles.getById.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to fetch cycle.'));
    }
  },
);

// ── POST /cycles/:id/close ────────────────────────────────────────────────────
// Close a cycle (Admin only). Two-step confirm. Idempotent.

router.post(
  '/cycles/:id/close',
  requireSession(),
  requireRole(RoleId.Admin),
  idempotencyKey(),
  validateBody(CloseCycleRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const cycleId = Number(req.params['id']);
    if (isNaN(cycleId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Cycle not found.'));
      return;
    }
    const body = req.body as CloseCycleRequest;
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      const result = await prisma.$transaction(async (tx) => {
        return closeCycle(cycleId, body.version, actor.id, actor.roleId as AuditActorRoleValue, ip, tx);
      });

      if (isServiceError(result)) {
        res.status(result.status).json(result.error);
        return;
      }

      res.status(200).json(result);
    } catch (err: unknown) {
      logger.error({ err }, 'performance.cycles.close.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to close cycle.'));
    }
  },
);

// ── GET /cycles/:id/reports/distribution ─────────────────────────────────────
// A-22 — rating distribution by department × rating bucket. Admin only.

router.get(
  '/cycles/:id/reports/distribution',
  requireSession(),
  requireRole(RoleId.Admin),
  async (req: Request, res: Response): Promise<void> => {
    const cycleId = Number(req.params['id']);
    if (isNaN(cycleId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Cycle not found.'));
      return;
    }

    try {
      const cycle = await prisma.performanceCycle.findUnique({
        where: { id: cycleId },
        select: { id: true, code: true },
      });

      if (!cycle) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Cycle not found.'));
        return;
      }

      // Fetch all reviews with employee department + finalRating
      const reviews = await prisma.performanceReview.findMany({
        where: { cycleId },
        include: {
          employee: {
            select: {
              department: { select: { name: true } },
            },
          },
        },
      });

      // Group by department
      const deptMap = new Map<string, { r1: number; r2: number; r3: number; r4: number; r5: number; notRated: number }>();

      for (const r of reviews) {
        const dept = r.employee.department?.name ?? 'Unassigned';
        if (!deptMap.has(dept)) {
          deptMap.set(dept, { r1: 0, r2: 0, r3: 0, r4: 0, r5: 0, notRated: 0 });
        }
        const bucket = deptMap.get(dept)!;

        switch (r.finalRating) {
          case 1: bucket.r1++; break;
          case 2: bucket.r2++; break;
          case 3: bucket.r3++; break;
          case 4: bucket.r4++; break;
          case 5: bucket.r5++; break;
          default: bucket.notRated++; break;
        }
      }

      const buckets: DistributionBucket[] = Array.from(deptMap.entries()).map(
        ([department, counts]) => ({
          department,
          rating1: counts.r1,
          rating2: counts.r2,
          rating3: counts.r3,
          rating4: counts.r4,
          rating5: counts.r5,
          notRated: counts.notRated,
        }),
      );

      res.status(200).json({
        data: { cycleId: cycle.id, cycleCode: cycle.code, buckets },
      });
    } catch (err: unknown) {
      logger.error({ err }, 'performance.distribution.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to generate distribution report.'));
    }
  },
);

// ── GET /cycles/:id/reports/missing ──────────────────────────────────────────
// A-23 — employees without manager rating in this cycle. Admin only.

router.get(
  '/cycles/:id/reports/missing',
  requireSession(),
  requireRole(RoleId.Admin),
  async (req: Request, res: Response): Promise<void> => {
    const cycleId = Number(req.params['id']);
    if (isNaN(cycleId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Cycle not found.'));
      return;
    }

    try {
      const cycle = await prisma.performanceCycle.findUnique({
        where: { id: cycleId },
        select: { id: true, code: true },
      });

      if (!cycle) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Cycle not found.'));
        return;
      }

      // Reviews where managerRating is null (no manager rating submitted yet)
      const reviews = await prisma.performanceReview.findMany({
        where: { cycleId, managerRating: null },
        include: {
          employee: {
            select: {
              name: true,
              code: true,
              department: { select: { name: true } },
              designation: { select: { name: true } },
            },
          },
          manager: { select: { name: true } },
        },
        orderBy: { createdAt: 'asc' },
      });

      const items: MissingReviewItem[] = reviews.map((r) => ({
        reviewId: r.id,
        employeeId: r.employeeId,
        employeeName: r.employee.name,
        employeeCode: r.employee.code,
        department: r.employee.department?.name ?? null,
        designation: r.employee.designation?.name ?? null,
        managerId: r.managerId ?? null,
        managerName: r.manager?.name ?? null,
        selfSubmitted: r.selfRating !== null,
        managerSubmitted: false,
      }));

      res.status(200).json({
        data: { cycleId: cycle.id, cycleCode: cycle.code, items },
      });
    } catch (err: unknown) {
      logger.error({ err }, 'performance.missing.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to generate missing reviews report.'));
    }
  },
);

// ── GET /reviews ──────────────────────────────────────────────────────────────
// List reviews with role-scoped visibility.

router.get(
  '/reviews',
  requireSession(),
  validateQuery(ReviewListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ReviewListQuery;
    const actor = req.user!;

    try {
      const limit = Number(query.limit ?? 20);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: Record<string, any> = {};

      if (query.cycleId) where['cycleId'] = Number(query.cycleId);

      if (actor.roleId === RoleId.Admin) {
        // Admin sees all — apply optional filters
        if (query.employeeId) where['employeeId'] = Number(query.employeeId);
        if (query.managerId) where['managerId'] = Number(query.managerId);
      } else if (actor.roleId === RoleId.Manager) {
        // Manager sees reviews where managerId=self OR employee in subordinates
        const subIds = await getSubordinateIds(actor.id);

        if (query.employeeId) {
          const empId = Number(query.employeeId);
          // Must still be scoped to actor's visibility
          if (empId === actor.id || subIds.includes(empId)) {
            where['employeeId'] = empId;
          } else {
            // Not in scope — return empty
            res.status(200).json({ data: [], nextCursor: null });
            return;
          }
        } else {
          where['OR'] = [
            { managerId: actor.id },
            { employeeId: { in: subIds } },
          ];
        }

        if (query.managerId) {
          const mgId = Number(query.managerId);
          // Only allow filtering by own managerId
          if (mgId !== actor.id) {
            res.status(200).json({ data: [], nextCursor: null });
            return;
          }
          where['managerId'] = actor.id;
        }
      } else {
        // Employee / PayrollOfficer — own review only
        where['employeeId'] = actor.id;
        // Ignore employeeId / managerId filters (they shouldn't be probing others)
      }

      if (query.cursor) {
        const cursorId = Number(query.cursor);
        if (!isNaN(cursorId)) {
          const cursorRow = await prisma.performanceReview.findFirst({
            where: { id: cursorId },
            select: { createdAt: true },
          });
          if (cursorRow) {
            where['createdAt'] = { lt: cursorRow.createdAt };
          }
        }
      }

      const reviews = await prisma.performanceReview.findMany({
        where,
        include: reviewInclude,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
      });

      const hasNext = reviews.length > limit;
      const items = hasNext ? reviews.slice(0, limit) : reviews;
      const nextCursor = hasNext ? String(items[items.length - 1]!.id) : null;

      res.status(200).json({
        data: items.map((r) => shapeReviewSummary(r)),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err }, 'performance.reviews.list.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to list reviews.'));
    }
  },
);

// ── GET /reviews/:id ──────────────────────────────────────────────────────────
// Get full review detail with visibility check.

router.get(
  '/reviews/:id',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const reviewId = Number(req.params['id']);
    if (isNaN(reviewId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Review not found.'));
      return;
    }
    const actor = req.user!;

    try {
      const review = await prisma.performanceReview.findUnique({
        where: { id: reviewId },
        include: reviewInclude,
      });

      if (!review) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Review not found.'));
        return;
      }

      // Visibility check
      let canView = false;

      if (actor.roleId === RoleId.Admin) {
        canView = true;
      } else if (actor.id === review.employeeId) {
        canView = true;
      } else if (actor.roleId === RoleId.Manager) {
        if (review.managerId === actor.id) {
          canView = true;
        } else {
          const subIds = await getSubordinateIds(actor.id);
          canView = subIds.includes(review.employeeId);
        }
      }

      if (!canView) {
        // Return 404 to avoid existence leak
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Review not found.'));
        return;
      }

      res.status(200).json({ data: shapeReviewDetail(review) });
    } catch (err: unknown) {
      logger.error({ err }, 'performance.reviews.getById.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to fetch review.'));
    }
  },
);

// ── POST /reviews/:id/goals ───────────────────────────────────────────────────
// Manager (assigned) or Admin creates a goal. Idempotent.

router.post(
  '/reviews/:id/goals',
  requireSession(),
  requireRole(RoleId.Admin, RoleId.Manager),
  idempotencyKey(),
  validateBody(CreateGoalRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const reviewId = Number(req.params['id']);
    if (isNaN(reviewId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Review not found.'));
      return;
    }
    const body = req.body as CreateGoalRequest;
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      const result = await prisma.$transaction(async (tx) => {
        return createGoal(reviewId, body.text, actor.id, actor.roleId as AuditActorRoleValue, ip, tx);
      });

      if (isServiceError(result)) {
        res.status(result.status).json(result.error);
        return;
      }

      res.status(201).json(result);
    } catch (err: unknown) {
      logger.error({ err }, 'performance.goals.create.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to create goal.'));
    }
  },
);

// ── POST /reviews/:id/goals/propose ──────────────────────────────────────────
// Employee (owner) proposes a goal during self-review window. Idempotent.

router.post(
  '/reviews/:id/goals/propose',
  requireSession(),
  idempotencyKey(),
  validateBody(ProposeGoalRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const reviewId = Number(req.params['id']);
    if (isNaN(reviewId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Review not found.'));
      return;
    }
    const body = req.body as ProposeGoalRequest;
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      const result = await prisma.$transaction(async (tx) => {
        return proposeGoal(reviewId, body.text, actor.id, actor.roleId as AuditActorRoleValue, ip, tx);
      });

      if (isServiceError(result)) {
        res.status(result.status).json(result.error);
        return;
      }

      res.status(201).json(result);
    } catch (err: unknown) {
      logger.error({ err }, 'performance.goals.propose.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to propose goal.'));
    }
  },
);

// ── PATCH /reviews/:id/self-rating ────────────────────────────────────────────
// Employee (owner) submits self-rating. Deadline-gated (BL-039). Idempotent.

router.patch(
  '/reviews/:id/self-rating',
  requireSession(),
  idempotencyKey(),
  validateBody(SelfRatingRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const reviewId = Number(req.params['id']);
    if (isNaN(reviewId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Review not found.'));
      return;
    }
    const body = req.body as SelfRatingRequest;
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      const result = await prisma.$transaction(async (tx) => {
        return submitSelfRating(
          reviewId,
          body.selfRating,
          body.selfNote,
          body.version,
          actor.id,
          actor.roleId as AuditActorRoleValue,
          ip,
          tx,
        );
      });

      if (isServiceError(result)) {
        res.status(result.status).json(result.error);
        return;
      }

      res.status(200).json(result);
    } catch (err: unknown) {
      logger.error({ err }, 'performance.reviews.self-rating.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to submit self-rating.'));
    }
  },
);

// ── POST /reviews/:id/manager-rating ─────────────────────────────────────────
// Manager (assigned) or Admin submits manager rating. Deadline-gated (BL-040). Idempotent.

router.post(
  '/reviews/:id/manager-rating',
  requireSession(),
  requireRole(RoleId.Admin, RoleId.Manager),
  idempotencyKey(),
  validateBody(ManagerRatingRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const reviewId = Number(req.params['id']);
    if (isNaN(reviewId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Review not found.'));
      return;
    }
    const body = req.body as ManagerRatingRequest;
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      const result = await prisma.$transaction(async (tx) => {
        return submitManagerRating(
          reviewId,
          body.managerRating,
          body.managerNote,
          body.goals,
          body.version,
          actor.id,
          actor.roleId as AuditActorRoleValue,
          ip,
          tx,
        );
      });

      if (isServiceError(result)) {
        res.status(result.status).json(result.error);
        return;
      }

      res.status(200).json(result);
    } catch (err: unknown) {
      logger.error({ err }, 'performance.reviews.manager-rating.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to submit manager rating.'));
    }
  },
);

export { router as performanceRouter };
