/**
 * Regularisation routes — Phase 3 (v2 INT schema).
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
import {
  RoleId,
  RegStatus,
} from '../../lib/statusInt.js';

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

    const proposedCheckIn = body.proposedCheckIn
      ? parseTimeOnDate(body.proposedCheckIn, body.date)
      : null;
    const proposedCheckOut = body.proposedCheckOut
      ? parseTimeOnDate(body.proposedCheckOut, body.date)
      : null;

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
          { roleId: user.roleId, ip: req.ip ?? null },
        );
      });

      res.status(201).json({ data: { regularisation: formatRegularisation(reg) } });
    } catch (err: unknown) {
      if (isRegConflict(err)) {
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
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to submit regularisation.'));
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
      status?: number;
      routedToId?: number;
      employeeId?: number;
      fromDate?: string;
      toDate?: string;
      cursor?: string;
      limit?: number;
    };

    try {
      const limit = Number(q.limit ?? 20);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: Record<string, any> = {};

      if (user.roleId === RoleId.Admin) {
        if (q.routedToId) where['routedToId'] = Number(q.routedToId);
        if (q.employeeId) where['employeeId'] = Number(q.employeeId);
      } else if (user.roleId === RoleId.Manager) {
        const subIds = await getSubordinateIds(user.id);
        if (q.employeeId) {
          const empId = Number(q.employeeId);
          if (empId === user.id) {
            where['employeeId'] = user.id;
          } else if (subIds.includes(empId)) {
            where['AND'] = [
              { employeeId: empId },
              { approverId: user.id },
            ];
          } else {
            res.status(200).json({ data: [], nextCursor: null });
            return;
          }
        } else {
          where['OR'] = [
            { employeeId: user.id },
            { employeeId: { in: subIds }, approverId: user.id },
          ];
        }
      } else {
        where['employeeId'] = user.id;
      }

      if (q.status) where['status'] = Number(q.status);

      if (q.fromDate || q.toDate) {
        where['date'] = {};
        if (q.fromDate) where['date']['gte'] = new Date(q.fromDate);
        if (q.toDate) where['date']['lte'] = new Date(q.toDate);
      }

      const cursorId = q.cursor && !isNaN(Number(q.cursor)) ? Number(q.cursor) : undefined;

      const rows = await prisma.regularisationRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
        include: {
          employee: { select: { name: true, code: true } },
          approver: { select: { name: true } },
        },
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? String(items[items.length - 1]!.id) : null;

      res.status(200).json({
        data: items.map((r) => ({
          id: r.id,
          code: r.code,
          employeeId: r.employeeId,
          employeeName: r.employee.name,
          employeeCode: r.employee.code,
          date: r.date.toISOString().split('T')[0]!,
          status: r.status,
          routedToId: r.routedToId,
          ageDaysAtSubmit: r.ageDaysAtSubmit,
          approverName: r.approver?.name ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err, userId: user.id }, 'regularisations.list: error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load regularisations.'));
    }
  },
);

// ── GET /regularisations/:id ──────────────────────────────────────────────────

regularisationsRouter.get(
  '/:id',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = Number(req.params['id']);

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Regularisation not found.'));
      return;
    }

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

      const visible = await prisma.$transaction(async (tx) => {
        return canSeeRegularisation(user.id, user.roleId, reg, tx);
      });

      if (!visible) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Regularisation not found.'));
        return;
      }

      res.status(200).json({ data: formatRegularisation(reg) });
    } catch (err: unknown) {
      logger.error({ err, regId: id, userId: user.id }, 'regularisations.get: error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load regularisation.'));
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
    const id = Number(req.params['id']);
    const body = req.body as { note?: string; version: number };

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Regularisation not found.'));
      return;
    }

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

      const isAdmin = user.roleId === RoleId.Admin;
      const isAssignedManager = user.roleId === RoleId.Manager && reg.approverId === user.id;

      if (!isAdmin && !isAssignedManager) {
        res.status(403).json(
          errorEnvelope(ErrorCode.FORBIDDEN, 'You are not authorised to approve this request.'),
        );
        return;
      }

      if (reg.status !== RegStatus.Pending) {
        res.status(400).json(
          errorEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `Regularisation has status ${reg.status} and cannot be approved.`,
          ),
        );
        return;
      }

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
          { roleId: user.roleId, ip: req.ip ?? null },
        );
      });

      res.status(200).json({ data: formatRegularisation(updated) });
    } catch (err: unknown) {
      logger.error({ err, regId: id, userId: user.id }, 'regularisations.approve: error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to approve regularisation.'));
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
    const id = Number(req.params['id']);
    const body = req.body as { note: string; version: number };

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Regularisation not found.'));
      return;
    }

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

      const isAdmin = user.roleId === RoleId.Admin;
      const isAssignedManager = user.roleId === RoleId.Manager && reg.approverId === user.id;

      if (!isAdmin && !isAssignedManager) {
        res.status(403).json(
          errorEnvelope(ErrorCode.FORBIDDEN, 'You are not authorised to reject this request.'),
        );
        return;
      }

      if (reg.status !== RegStatus.Pending) {
        res.status(400).json(
          errorEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `Regularisation has status ${reg.status} and cannot be rejected.`,
          ),
        );
        return;
      }

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
          { roleId: user.roleId, ip: req.ip ?? null },
        );
      });

      res.status(200).json({ data: formatRegularisation(updated) });
    } catch (err: unknown) {
      logger.error({ err, regId: id, userId: user.id }, 'regularisations.reject: error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to reject regularisation.'));
    }
  },
);
