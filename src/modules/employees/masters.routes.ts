/**
 * Master directory endpoints — Phase 5/6 (defect D1 fix).
 *
 * Surfaces the seven master/lookup tables so the frontend can hydrate
 * dropdowns without hardcoding values:
 *
 *   GET  /masters/roles              all signed-in users  — used in employee forms (Admin)
 *   GET  /masters/employment-types   all signed-in users
 *   GET  /masters/departments        all signed-in users
 *   GET  /masters/designations       all signed-in users
 *   GET  /masters/genders            all signed-in users
 *
 *   POST /masters/departments        Admin only           — create a new department
 *   POST /masters/designations       Admin only           — create a new designation
 *
 * Role + employment-type + gender masters are FROZEN (seeded with fixed
 * IDs); there is no public create endpoint for them. Departments and
 * designations are admin-managed and grow over time.
 *
 * All list endpoints filter to `status = 1` (Active) so deprecated rows
 * never appear in dropdowns. Active rows are ordered by name ASC.
 */

import { Router, type Request, type Response } from 'express';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import {
  CreateDepartmentRequestSchema,
  CreateDesignationRequestSchema,
  type CreateDepartmentRequest,
  type CreateDesignationRequest,
} from '@nexora/contracts/employees';

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { requireSession } from '../../middleware/requireSession.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validateBody.js';
import { RoleId, MasterStatus } from '../../lib/statusInt.js';

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

function clientIp(req: Request): string | null {
  return (req.ip ?? req.socket.remoteAddress ?? null) || null;
}

/** Wire shape for every master row: `{ id, name }`. */
type MasterRow = { id: number; name: string };

function mapRow(r: { id: number; name: string }): MasterRow {
  return { id: r.id, name: r.name };
}

// ── GET listers (auth-required, no role gate — every signed-in user reads) ─

router.get('/roles', requireSession(), async (_req, res: Response): Promise<void> => {
  try {
    const rows = await prisma.role.findMany({
      where: { status: MasterStatus.Active },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    res.status(200).json({ data: rows.map(mapRow) });
  } catch (err: unknown) {
    logger.error({ err }, 'masters.roles.list.error');
    res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to list roles.'));
  }
});

router.get('/employment-types', requireSession(), async (_req, res: Response): Promise<void> => {
  try {
    const rows = await prisma.employmentType.findMany({
      where: { status: MasterStatus.Active },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    res.status(200).json({ data: rows.map(mapRow) });
  } catch (err: unknown) {
    logger.error({ err }, 'masters.employment-types.list.error');
    res
      .status(500)
      .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to list employment types.'));
  }
});

router.get('/genders', requireSession(), async (_req, res: Response): Promise<void> => {
  try {
    const rows = await prisma.gender.findMany({
      where: { status: MasterStatus.Active },
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
    });
    res.status(200).json({ data: rows.map(mapRow) });
  } catch (err: unknown) {
    logger.error({ err }, 'masters.genders.list.error');
    res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to list genders.'));
  }
});

router.get('/departments', requireSession(), async (_req, res: Response): Promise<void> => {
  try {
    const rows = await prisma.department.findMany({
      where: { status: MasterStatus.Active },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    res.status(200).json({ data: rows.map(mapRow) });
  } catch (err: unknown) {
    logger.error({ err }, 'masters.departments.list.error');
    res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to list departments.'));
  }
});

router.get('/designations', requireSession(), async (_req, res: Response): Promise<void> => {
  try {
    const rows = await prisma.designation.findMany({
      where: { status: MasterStatus.Active },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    res.status(200).json({ data: rows.map(mapRow) });
  } catch (err: unknown) {
    logger.error({ err }, 'masters.designations.list.error');
    res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to list designations.'));
  }
});

// ── Admin-only create endpoints ────────────────────────────────────────────

router.post(
  '/departments',
  requireSession(),
  requireRole(RoleId.Admin),
  validateBody(CreateDepartmentRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateDepartmentRequest;
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      // Treat the name as the unique key (matches the Prisma @unique on Department.name).
      const existing = await prisma.department.findUnique({ where: { name: body.name } });
      if (existing) {
        // Idempotent: return the existing row instead of erroring.
        res.status(200).json({ data: mapRow(existing) });
        return;
      }

      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.department.create({
          data: { name: body.name },
          select: { id: true, name: true },
        });
        await audit({
          tx,
          actorId: actor.id,
          actorRole: 'Admin',
          actorIp: ip,
          action: 'masters.department.created',
          targetType: null,
          targetId: row.id,
          module: 'employees',
          before: null,
          after: { id: row.id, name: row.name },
        });
        return row;
      });

      res.status(201).json({ data: mapRow(created) });
    } catch (err: unknown) {
      logger.error({ err }, 'masters.departments.create.error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to create department.'));
    }
  },
);

router.post(
  '/designations',
  requireSession(),
  requireRole(RoleId.Admin),
  validateBody(CreateDesignationRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateDesignationRequest;
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      const existing = await prisma.designation.findUnique({ where: { name: body.name } });
      if (existing) {
        res.status(200).json({ data: mapRow(existing) });
        return;
      }

      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.designation.create({
          data: { name: body.name },
          select: { id: true, name: true },
        });
        await audit({
          tx,
          actorId: actor.id,
          actorRole: 'Admin',
          actorIp: ip,
          action: 'masters.designation.created',
          targetType: null,
          targetId: row.id,
          module: 'employees',
          before: null,
          after: { id: row.id, name: row.name },
        });
        return row;
      });

      res.status(201).json({ data: mapRow(created) });
    } catch (err: unknown) {
      logger.error({ err }, 'masters.designations.create.error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to create designation.'));
    }
  },
);

export { router as mastersRouter };
