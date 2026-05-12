/**
 * Leave Encashment routes (v2 schema: INT IDs, INT status/role codes).
 *
 * Mounted at /api/v1/leave-encashments
 *
 * Endpoints:
 *   POST   /                     — submit encashment request (Employee)
 *   GET    /                     — list (scoped by role)
 *   GET    /queue                — approval queue (Manager / Admin)
 *   GET    /:id                  — detail
 *   POST   /:id/cancel           — cancel (Employee pre-ManagerApproved, or Admin)
 *   POST   /:id/manager-approve  — Manager approval
 *   POST   /:id/admin-finalise   — Admin finalisation
 *   POST   /:id/reject           — reject (Manager or Admin)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireSession } from '../../middleware/requireSession.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validateBody.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { idempotencyKey } from '../../middleware/idempotencyKey.js';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import {
  LeaveEncashmentRequestSchema,
  LeaveEncashmentListQuerySchema,
  ManagerApproveEncashmentBodySchema,
  AdminFinaliseEncashmentBodySchema,
  RejectEncashmentBodySchema,
  CancelEncashmentBodySchema,
} from '@nexora/contracts/leave-encashment';
import {
  submitEncashmentRequest,
  managerApproveEncashment,
  adminFinaliseEncashment,
  rejectEncashment,
  cancelEncashment,
  formatEncashment,
} from './leave-encashment.service.js';
import { getSubordinateIds } from '../employees/hierarchy.js';
import {
  RoleId,
  EmployeeStatus,
  LeaveEncashmentStatus,
  type AuditActorRoleValue,
} from '../../lib/statusInt.js';

// ── Router ────────────────────────────────────────────────────────────────────

export const leaveEncashmentRouter = Router();

// ── Include shape for findMany ────────────────────────────────────────────────

const encashmentInclude = {
  employee: { select: { name: true, code: true } },
  approver: { select: { name: true } },
} as const;

// ── Error handler helper ──────────────────────────────────────────────────────

type TxErr = Error & {
  statusCode?: number;
  code?: string;
  ruleId?: string;
  details?: Record<string, unknown>;
};

function handleTxError(err: unknown, res: Response): boolean {
  const txErr = err as TxErr;
  if (txErr.statusCode && txErr.code) {
    res.status(txErr.statusCode).json(
      errorEnvelope(txErr.code, txErr.message, {
        ruleId: txErr.ruleId,
        details: txErr.details,
      }),
    );
    return true;
  }
  return false;
}

// ── Visibility helper ─────────────────────────────────────────────────────────

async function canViewEncashment(
  userId: number,
  userRoleId: number,
  ownerId: number,
): Promise<boolean> {
  if (userRoleId === RoleId.Admin) return true;
  if (userId === ownerId) return true;

  if (userRoleId === RoleId.Manager) {
    const subs = await getSubordinateIds(userId);
    return subs.includes(ownerId);
  }

  return false;
}

// ── POST /leave-encashments ───────────────────────────────────────────────────

leaveEncashmentRouter.post(
  '/',
  requireSession(),
  idempotencyKey(),
  validateBody(LeaveEncashmentRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { year, daysRequested } = req.body as { year: number; daysRequested: number };

    try {
      const result = await prisma.$transaction(async (tx) => {
        return submitEncashmentRequest(user.id, daysRequested, year, tx, req.ip ?? null);
      });
      res.status(201).json({ data: result });
    } catch (err: unknown) {
      if (handleTxError(err, res)) return;
      throw err;
    }
  },
);

// ── GET /leave-encashments ────────────────────────────────────────────────────

leaveEncashmentRouter.get(
  '/',
  requireSession(),
  validateQuery(LeaveEncashmentListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { year, status, employeeId, cursor, limit } = req.query as {
      year?: string;
      status?: string;
      employeeId?: string;
      cursor?: string;
      limit?: string;
    };

    const take = (Number(limit) || 20) + 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {};

    if (user.roleId === RoleId.Employee) {
      where['employeeId'] = user.id;
    } else if (user.roleId === RoleId.Manager) {
      const subs = await getSubordinateIds(user.id);
      const allowed = [user.id, ...subs];
      if (employeeId) {
        const empIdNum = Number(employeeId);
        if (!allowed.includes(empIdNum)) {
          res.status(200).json({ data: [], nextCursor: null });
          return;
        }
        where['employeeId'] = empIdNum;
      } else {
        where['employeeId'] = { in: allowed };
      }
    } else {
      // Admin / PayrollOfficer — see all
      if (employeeId) where['employeeId'] = Number(employeeId);
    }

    if (year) where['year'] = Number(year);
    if (status) where['status'] = Number(status);
    if (cursor) where['id'] = { gt: Number(cursor) };

    const items = await prisma.leaveEncashment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      include: encashmentInclude,
    });

    const hasMore = items.length > (Number(limit) || 20);
    const page = hasMore ? items.slice(0, Number(limit) || 20) : items;
    const lastId = page[page.length - 1]?.id ?? null;
    const nextCursor = hasMore && lastId !== null ? String(lastId) : null;

    res.status(200).json({ data: page.map(formatEncashment), nextCursor });
  },
);

// ── GET /leave-encashments/queue ──────────────────────────────────────────────
// NOTE: this route MUST be declared before /:id to avoid "queue" being treated as an id

leaveEncashmentRouter.get(
  '/queue',
  requireSession(),
  requireRole(RoleId.Manager, RoleId.Admin),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    const take = (Number(limit) || 20) + 1;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {
      status: { in: [LeaveEncashmentStatus.Pending, LeaveEncashmentStatus.ManagerApproved] },
    };

    if (user.roleId === RoleId.Manager) {
      where['approverId'] = user.id;
    }
    // Admin sees all pending/manager-approved

    if (cursor) where['id'] = { gt: Number(cursor) };

    const items = await prisma.leaveEncashment.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take,
      include: encashmentInclude,
    });

    const hasMore = items.length > (Number(limit) || 20);
    const page = hasMore ? items.slice(0, Number(limit) || 20) : items;
    const lastId = page[page.length - 1]?.id ?? null;
    const nextCursor = hasMore && lastId !== null ? String(lastId) : null;

    res.status(200).json({ data: page.map(formatEncashment), nextCursor });
  },
);

// ── GET /leave-encashments/:id ────────────────────────────────────────────────

leaveEncashmentRouter.get(
  '/:id',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = Number(req.params['id']);
    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Encashment request not found.'));
      return;
    }

    const enc = await prisma.leaveEncashment.findUnique({
      where: { id },
      include: encashmentInclude,
    });

    if (!enc) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Encashment request not found.'));
      return;
    }

    // Visibility check
    const canSee = await canViewEncashment(user.id, user.roleId, enc.employeeId);
    if (!canSee) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Encashment request not found.'));
      return;
    }

    res.status(200).json({ data: formatEncashment(enc) });
  },
);

// ── POST /leave-encashments/:id/cancel ────────────────────────────────────────

leaveEncashmentRouter.post(
  '/:id/cancel',
  requireSession(),
  idempotencyKey(),
  validateBody(CancelEncashmentBodySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = Number(req.params['id']);
    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Encashment request not found.'));
      return;
    }
    const { note, version } = req.body as { note?: string; version: number };

    // Load for version check
    const enc = await prisma.leaveEncashment.findUnique({ where: { id } });
    if (!enc) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Encashment request not found.'));
      return;
    }

    if (enc.version !== version) {
      res.status(409).json(
        errorEnvelope(ErrorCode.VERSION_MISMATCH, 'The request has been modified. Please refresh and retry.'),
      );
      return;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        return cancelEncashment(id, user.id, user.roleId as AuditActorRoleValue, tx, req.ip ?? null, note);
      });
      res.status(200).json({ data: result });
    } catch (err: unknown) {
      if (handleTxError(err, res)) return;
      throw err;
    }
  },
);

// ── POST /leave-encashments/:id/manager-approve ───────────────────────────────

leaveEncashmentRouter.post(
  '/:id/manager-approve',
  requireSession(),
  requireRole(RoleId.Manager),
  idempotencyKey(),
  validateBody(ManagerApproveEncashmentBodySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = Number(req.params['id']);
    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Encashment request not found.'));
      return;
    }
    const { note, version } = req.body as { note?: string; version: number };

    const enc = await prisma.leaveEncashment.findUnique({ where: { id } });
    if (!enc) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Encashment request not found.'));
      return;
    }

    if (enc.version !== version) {
      res.status(409).json(
        errorEnvelope(ErrorCode.VERSION_MISMATCH, 'The request has been modified. Please refresh and retry.'),
      );
      return;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        return managerApproveEncashment(id, user.id, note, tx, user.roleId as AuditActorRoleValue, req.ip ?? null);
      });
      res.status(200).json({ data: result });
    } catch (err: unknown) {
      if (handleTxError(err, res)) return;
      throw err;
    }
  },
);

// ── POST /leave-encashments/:id/admin-finalise ────────────────────────────────

leaveEncashmentRouter.post(
  '/:id/admin-finalise',
  requireSession(),
  requireRole(RoleId.Admin),
  idempotencyKey(),
  validateBody(AdminFinaliseEncashmentBodySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = Number(req.params['id']);
    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Encashment request not found.'));
      return;
    }
    const { daysApproved, note, version } = req.body as {
      daysApproved?: number;
      note?: string;
      version: number;
    };

    const enc = await prisma.leaveEncashment.findUnique({ where: { id } });
    if (!enc) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Encashment request not found.'));
      return;
    }

    if (enc.version !== version) {
      res.status(409).json(
        errorEnvelope(ErrorCode.VERSION_MISMATCH, 'The request has been modified. Please refresh and retry.'),
      );
      return;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        return adminFinaliseEncashment(id, user.id, daysApproved, note, tx, user.roleId as AuditActorRoleValue, req.ip ?? null);
      });
      res.status(200).json({ data: result });
    } catch (err: unknown) {
      if (handleTxError(err, res)) return;
      throw err;
    }
  },
);

// ── POST /leave-encashments/:id/reject ────────────────────────────────────────

leaveEncashmentRouter.post(
  '/:id/reject',
  requireSession(),
  requireRole(RoleId.Manager, RoleId.Admin),
  idempotencyKey(),
  validateBody(RejectEncashmentBodySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = Number(req.params['id']);
    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Encashment request not found.'));
      return;
    }
    const { note, version } = req.body as { note: string; version: number };

    const enc = await prisma.leaveEncashment.findUnique({ where: { id } });
    if (!enc) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Encashment request not found.'));
      return;
    }

    if (enc.version !== version) {
      res.status(409).json(
        errorEnvelope(ErrorCode.VERSION_MISMATCH, 'The request has been modified. Please refresh and retry.'),
      );
      return;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        return rejectEncashment(id, user.id, note, tx, user.roleId as AuditActorRoleValue, req.ip ?? null);
      });
      res.status(200).json({ data: result });
    } catch (err: unknown) {
      if (handleTxError(err, res)) return;
      throw err;
    }
  },
);

// Suppress unused import warning — EmployeeStatus imported for future queue filter extensions
void EmployeeStatus;
