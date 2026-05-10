/**
 * Holidays configuration routes — Phase 3.
 *
 * Mounted at /api/v1/config/holidays
 *
 * Endpoints:
 *   GET  /   requireSession — returns the holiday calendar for a given year
 *   PUT  /   Admin only     — replaces the entire calendar for a given year
 *
 * Rules:
 *   GET  available to all signed-in users (used by client-side status derivation)
 *   PUT  replaces all rows for the year atomically; audits config.holidays.replace
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireSession } from '../../middleware/requireSession.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validateBody.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { audit } from '../../lib/audit.js';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import { ReplaceHolidaysRequestSchema } from '@nexora/contracts/attendance';
import { logger } from '../../lib/logger.js';

export const holidaysRouter = Router();

// ── GET /config/holidays ──────────────────────────────────────────────────────

const HolidayGetQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2999).optional(),
});

holidaysRouter.get(
  '/',
  requireSession(),
  validateQuery(HolidayGetQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const q = req.query as unknown as { year?: number };
    const year = q.year ?? new Date().getUTCFullYear();

    try {
      const holidays = await prisma.holiday.findMany({
        where: { year },
        orderBy: { date: 'asc' },
        select: { id: true, date: true, name: true },
      });

      res.status(200).json({
        data: holidays.map((h) => ({
          id: h.id,
          date: h.date.toISOString().split('T')[0]!,
          name: h.name,
        })),
      });
    } catch (err: unknown) {
      logger.error({ err, year }, 'holidays.get: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load holidays.'));
    }
  },
);

// ── PUT /config/holidays ──────────────────────────────────────────────────────

holidaysRouter.put(
  '/',
  requireSession(),
  requireRole('Admin'),
  validateBody(ReplaceHolidaysRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const body = req.body as {
      year: number;
      holidays: Array<{ date: string; name: string }>;
    };

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Load existing holidays for before snapshot in audit
        const before = await tx.holiday.findMany({
          where: { year: body.year },
          select: { date: true, name: true },
          orderBy: { date: 'asc' },
        });

        // Replace: delete all rows for the year, then re-insert
        await tx.holiday.deleteMany({ where: { year: body.year } });

        const created = await Promise.all(
          body.holidays.map(async (h) => {
            const d = new Date(h.date);
            d.setUTCHours(0, 0, 0, 0);
            return tx.holiday.create({
              data: {
                year: body.year,
                date: d,
                name: h.name,
              },
              select: { id: true, date: true, name: true },
            });
          }),
        );

        // Audit config.holidays.replace
        await audit({
          tx,
          actorId: user.id,
          actorRole: user.role,
          actorIp: null,
          action: 'config.holidays.replace',
          targetType: 'Holiday',
          targetId: String(body.year),
          module: 'attendance',
          before: {
            year: body.year,
            count: before.length,
            holidays: before.map((h) => ({
              date: h.date.toISOString().split('T')[0],
              name: h.name,
            })),
          },
          after: {
            year: body.year,
            count: created.length,
            holidays: body.holidays,
          },
        });

        return created;
      });

      res.status(200).json({
        data: result.map((h) => ({
          id: h.id,
          date: h.date.toISOString().split('T')[0]!,
          name: h.name,
        })),
      });
    } catch (err: unknown) {
      logger.error({ err, year: body.year, userId: user.id }, 'holidays.replace: error');
      res
        .status(500)
        .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to replace holidays.'));
    }
  },
);
