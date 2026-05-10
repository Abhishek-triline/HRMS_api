/**
 * Regularisation routes — Phase 3.
 *
 * Mounted at /api/v1/regularisations
 *
 * Endpoints:
 *   POST  /                    requireSession — E-07 (BL-010 / BL-029)
 *   GET   /                    requireSession — E-07/M-06/A-10 (scoped by role)
 *   GET   /:id                 requireSession + canSeeRegularisation
 *   POST  /:id/approve         (Manager AND approverId==self) OR Admin
 *   POST  /:id/reject          same
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireSession } from '../../middleware/requireSession.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validateBody.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import {
  CreateRegularisationRequestSchema,
  ApproveRegularisationRequestSchema,
  RejectRegularisationRequestSchema,
  RegularisationListQuerySchema,
} from '@nexora/contracts/attendance';
import { getSubordinateIds } from '../employees/hierarchy.js';
import { logger } from '../../lib/logger.js';
import type { RegularisationConflictError } from './attendance.service.js';
import {
  submitRegularisation,
  approveRegularisation,
  rejectRegularisation,
  canSeeRegularisation,
  formatRegularisation,
} from './attendance.service.js';

export const regularisationsRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Type guard for RegularisationConflictError thrown by the service. */
function isRegConflict(err: unknown): err is RegularisationConflictError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as Record<string, unknown>)['code'] === ErrorCode.LEAVE_REG_CONFLICT
  );
}

/** Parse "HH:MM" time string + date string into a UTC DateTime. */
function parseTimeOnDate(timeHHMM: string, dateStr: string): Date {
  const [hStr, mStr] = timeHHMM.split(':');
  const h = parseInt(hStr ?? '0', 10);
  const m = parseInt(mStr ?? '0', 10);
  // dateStr is YYYY-MM-DD; build a full ISO-8601 string in IST offset (+05:30)
  // so the resulting Date is correctly stored as UTC.
  const isoStr = `${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`;
  return new Date(isoStr);
}

// ── POST /regularisations ─────────────────────────────────────────────────────

regularisationsRouter.post(
  '/',
  requireSession(),
  validateBody(CreateRegularisationRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const body = req.body as {
      date: string;
      proposedCheckIn?: string | null;
      proposedCheckOut?: string | null;
      reason: string;
    };

    // Validate date < today
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const requestedDate = new Date(body.date);
    requestedDate.setUTCHours(0, 0, 0, 0);

    if (requestedDate >= today) {
      res.status(400).json(
        errorEnvelope(
          ErrorCode.VALIDATION_FAILED,
          'Regularisation date must be in the past.',
          { details: { date: ['Date must be before today.'] } },
        ),
      );
      return;
    }

    // Parse proposed times onto the date
    const proposedCheckIn = body.proposedCheckIn
      ? parseTimeOnDate(body.proposedCheckIn, body.date)
      : null;
    const proposedCheckOut = body.proposedCheckOut
      ? parseTimeOnDate(body.proposedCheckOut, body.date)
      : null;

    // Validate check-in < check-out if both provided
    if (proposedCheckIn && proposedCheckOut && proposedCheckOut <= proposedCheckIn) {
      res.status(400).json(
        errorEnvelope(
          ErrorCode.VALIDATION_FAILED,
          'proposedCheckOut must be after proposedCheckIn.',
          { details: { proposedCheckOut: ['Must be after check-in time.'] } },
        ),
      );
      return;
    }

    try {
      const reg = await prisma.$transaction(async (tx) => {
        return submitRegularisation(
          user.id,
          {
            date: requestedDate,
            proposedCheckIn,
            proposedCheckOut,
            reason: body.reason,
          },
          tx,
          { role: user.role, ip: req.ip ?? null },
        );
      });

      res.status(201).json({
        data: {
          regularisation: formatRegularisation(reg),
        },
      });
    } catch (err: unknown) {
      if (isRegConflict(err)) {
        // BL-010: leave/reg conflict with specific code (DN-19)
        res.status(409).json(
          errorEnvelope(
            ErrorCode.LEAVE_REG_CONFLICT,
            'An approved leave covers this date — regularisation cannot be submitted.',
            { details: err.details, ruleId: 'BL-010' },
          ),
        );
        return;
      }
      logger.error({ err, userId: user.id }, 'regularisations.create: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to submit regularisation.'));
    }
  },
);

// ── GET /regularisations ──────────────────────────────────────────────────────

regularisationsRouter.get(
  '/',
  requireSession(),
  validateQuery(RegularisationListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const q = req.query as unknown as {
      status?: string;
      routedTo?: string;
      employeeId?: string;
      fromDate?: string;
      toDate?: string;
      cursor?: string;
      limit?: number;
    };

    try {
      const limit = Number(q.limit ?? 20);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic Prisma where building
      const where: Record<string, any> = {};

      // Scoping rules per role (BL-004 / SEC-001-P2 pattern):
      //   Employee → only own requests
      //   Manager  → own + subordinates' requests routed to Manager AND approverId=self
      //   Admin    → all, optional ?routedTo=Admin filter
      //   PayrollOfficer → only own (same as Employee)
      if (user.role === 'Admin') {
        // Admin sees all; optional routedTo filter
        if (q.routedTo) {
          where['routedTo'] = q.routedTo;
        }
        if (q.employeeId) {
          where['employeeId'] = q.employeeId;
        }
      } else if (user.role === 'Manager') {
        // SEC-001-P3 fix — when ?employeeId is supplied, the previous code
        // dropped the approverId guard and exposed Admin-routed corrections
        // belonging to a subordinate. Tighten: filtering by self returns
        // own requests; filtering by a subordinate returns only the rows
        // where this manager IS the assigned approver. Anything else 404s.
        const subIds = await getSubordinateIds(user.id);
        if (q.employeeId) {
          if (q.employeeId === user.id) {
            where['employeeId'] = user.id;
          } else if (subIds.includes(q.employeeId)) {
            where['AND'] = [
              { employeeId: q.employeeId },
              { approverId: user.id },
            ];
          } else {
            res.status(200).json({ data: [], nextCursor: null });
            return;
          }
        } else {
          // Own requests OR subordinates' requests where approverId = self
          where['OR'] = [
            { employeeId: user.id },
            {
              employeeId: { in: subIds },
              approverId: user.id,
            },
          ];
        }
      } else {
        // Employee / PayrollOfficer — only own requests
        where['employeeId'] = user.id;
      }

      if (q.status) {
        where['status'] = q.status;
      }

      if (q.fromDate || q.toDate) {
        where['date'] = {};
        if (q.fromDate) where['date']['gte'] = new Date(q.fromDate);
        if (q.toDate) where['date']['lte'] = new Date(q.toDate);
      }

      const rows = await prisma.regularisationRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        include: {
          employee: { select: { name: true, code: true } },
          approver: { select: { name: true } },
        },
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1]!.id : null;

      res.status(200).json({
        data: items.map((r) => ({
          id: r.id,
          code: r.code,
          employeeId: r.employeeId,
          employeeName: r.employee.name,
          employeeCode: r.employee.code,
          date: r.date.toISOString().split('T')[0]!,
          status: r.status as 'Pending' | 'Approved' | 'Rejected',
          routedTo: r.routedTo as 'Manager' | 'Admin',
          ageDaysAtSubmit: r.ageDaysAtSubmit,
          approverName: r.approver?.name ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err, userId: user.id }, 'regularisations.list: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load regularisations.'));
    }
  },
);

// ── GET /regularisations/:id ──────────────────────────────────────────────────

regularisationsRouter.get(
  '/:id',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { id } = req.params;

    try {
      const reg = await prisma.regularisationRequest.findUnique({
        where: { id },
        include: {
          employee: { select: { name: true, code: true } },
          approver: { select: { name: true } },
        },
      });

      if (!reg) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Regularisation not found.'));
        return;
      }

      // Ownership / visibility check
      const visible = await prisma.$transaction(async (tx) => {
        return canSeeRegularisation(user.id, user.role, reg, tx);
      });

      if (!visible) {
        // Return 404 to avoid leaking existence (HRMS_API.md § 1)
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Regularisation not found.'));
        return;
      }

      res.status(200).json({ data: formatRegularisation(reg) });
    } catch (err: unknown) {
      logger.error({ err, regId: id, userId: user.id }, 'regularisations.get: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load regularisation.'));
    }
  },
);

// ── POST /regularisations/:id/approve ────────────────────────────────────────

regularisationsRouter.post(
  '/:id/approve',
  requireSession(),
  validateBody(ApproveRegularisationRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { id } = req.params;
    const body = req.body as { note?: string; version: number };

    try {
      const reg = await prisma.regularisationRequest.findUnique({
        where: { id },
        include: {
          employee: { select: { name: true, code: true } },
          approver: { select: { name: true } },
        },
      });

      if (!reg) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Regularisation not found.'));
        return;
      }

      // Authorisation: (Manager AND approverId == self) OR Admin
      const isAdmin = user.role === 'Admin';
      const isAssignedManager =
        user.role === 'Manager' && reg.approverId === user.id;

      if (!isAdmin && !isAssignedManager) {
        res.status(403).json(
          errorEnvelope(ErrorCode.FORBIDDEN, 'You are not authorised to approve this request.'),
        );
        return;
      }

      // Status check: only Pending can be approved
      if (reg.status !== 'Pending') {
        res.status(400).json(
          errorEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `Regularisation is already ${reg.status.toLowerCase()} and cannot be approved.`,
          ),
        );
        return;
      }

      // Optimistic concurrency check (BL-034)
      if (reg.version !== body.version) {
        res.status(409).json(
          errorEnvelope(
            ErrorCode.VERSION_MISMATCH,
            'Regularisation was modified by another user. Please reload and try again.',
            { details: { current: reg.version, provided: body.version } },
          ),
        );
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        return approveRegularisation(
          {
            id: reg.id,
            employeeId: reg.employeeId,
            date: reg.date,
            proposedCheckIn: reg.proposedCheckIn,
            proposedCheckOut: reg.proposedCheckOut,
            version: reg.version,
            approverId: reg.approverId,
          },
          user.id,
          body.note,
          tx,
          { role: user.role, ip: req.ip ?? null },
        );
      });

      res.status(200).json({ data: formatRegularisation(updated) });
    } catch (err: unknown) {
      logger.error({ err, regId: id, userId: user.id }, 'regularisations.approve: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to approve regularisation.'));
    }
  },
);

// ── POST /regularisations/:id/reject ─────────────────────────────────────────

regularisationsRouter.post(
  '/:id/reject',
  requireSession(),
  validateBody(RejectRegularisationRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { id } = req.params;
    const body = req.body as { note: string; version: number };

    try {
      const reg = await prisma.regularisationRequest.findUnique({
        where: { id },
        include: {
          employee: { select: { name: true, code: true } },
          approver: { select: { name: true } },
        },
      });

      if (!reg) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Regularisation not found.'));
        return;
      }

      // Authorisation: (Manager AND approverId == self) OR Admin
      const isAdmin = user.role === 'Admin';
      const isAssignedManager =
        user.role === 'Manager' && reg.approverId === user.id;

      if (!isAdmin && !isAssignedManager) {
        res.status(403).json(
          errorEnvelope(ErrorCode.FORBIDDEN, 'You are not authorised to reject this request.'),
        );
        return;
      }

      // Status check: only Pending can be rejected
      if (reg.status !== 'Pending') {
        res.status(400).json(
          errorEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `Regularisation is already ${reg.status.toLowerCase()} and cannot be rejected.`,
          ),
        );
        return;
      }

      // Optimistic concurrency check (BL-034)
      if (reg.version !== body.version) {
        res.status(409).json(
          errorEnvelope(
            ErrorCode.VERSION_MISMATCH,
            'Regularisation was modified by another user. Please reload and try again.',
            { details: { current: reg.version, provided: body.version } },
          ),
        );
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        return rejectRegularisation(
          { id: reg.id, version: reg.version },
          user.id,
          body.note,
          tx,
          { role: user.role, ip: req.ip ?? null },
        );
      });

      res.status(200).json({ data: formatRegularisation(updated) });
    } catch (err: unknown) {
      logger.error({ err, regId: id, userId: user.id }, 'regularisations.reject: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to reject regularisation.'));
    }
  },
);
