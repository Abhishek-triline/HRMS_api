/**
 * Payroll routes — Phase 4.
 *
 * Mounted at /api/v1/ (three sub-routers merged here for clean grouping):
 *   payrollRouter   → /api/v1/payroll/*
 *   payslipsRouter  → /api/v1/payslips/*
 *   taxConfigRouter → /api/v1/config/tax
 *
 * Run state model (simplified from SRS — see implementation choice note):
 *   STATUS GATE: Run is created with status='Review' (skipping Draft).
 *   Rationale: The SRS uses Draft and Review loosely; what matters for BL-036a
 *   is that PO can edit tax until Finalise. We create runs as 'Review' so the
 *   PO can immediately edit payslip taxes. 'Draft' is reserved if a future
 *   phase needs a pre-compute staging state.
 *
 * BL-034 concurrency guard: finalise and reverse both use SELECT … FOR UPDATE
 * inside a Prisma interactive transaction to prevent two simultaneous callers
 * from finalising/reversing the same run.
 *
 * BL-031 / BL-032: finalised payslips' financial fields are NEVER updated;
 * reversals create new rows. The back-link field `reversedByPayslipId` IS
 * set on the original payslip by the reversal handler — that's a schema-
 * intended pointer, not a financial mutation (SEC-004-P4 doc clarification).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireSession } from '../../middleware/requireSession.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validateBody.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { idempotencyKey } from '../../middleware/idempotencyKey.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import {
  CreatePayrollRunRequestSchema,
  PayrollRunListQuerySchema,
  FinaliseRunRequestSchema,
  ReverseRunRequestSchema,
  PayslipListQuerySchema,
  UpdatePayslipTaxRequestSchema,
  UpdateTaxSettingsRequestSchema,
} from '@nexora/contracts/payroll';
import { PaginationQuerySchema } from '@nexora/contracts/common';
import { getSubordinateIds } from '../employees/hierarchy.js';
import { computeWorkingDays } from './workingDaysCalc.js';
import { computePayslip, recomputeNet } from './payrollEngine.js';
import {
  generateRunCode,
  generateReversalRunCode,
  generatePayslipCode,
} from './payrollCode.js';
import { acquireRunLock } from './concurrencyGuard.js';
import { streamPayslipPDF } from './payslip.pdf.js';
import { notify } from '../../lib/notifications.js';

// ── Routers ───────────────────────────────────────────────────────────────────

export const payrollRouter = Router();
export const payslipsRouter = Router();
export const taxConfigRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a PayrollRun row for the API response. */
function formatRun(
  run: {
    id: string;
    code: string;
    month: number;
    year: number;
    status: string;
    workingDays: number;
    periodStart: Date;
    periodEnd: Date;
    initiatedBy: string;
    initiator: { name: string };
    finalisedBy: string | null;
    finaliser?: { name: string } | null;
    finalisedAt: Date | null;
    reversedBy: string | null;
    reverser?: { name: string } | null;
    reversedAt: Date | null;
    reversalReason: string | null;
    reversalOfRunId: string | null;
    createdAt: Date;
    updatedAt: Date;
    version: number;
    payslips?: Array<{
      grossPaise: number;
      lopDeductionPaise: number;
      finalTaxPaise: number;
      netPayPaise: number;
    }>;
  },
) {
  const slips = run.payslips ?? [];
  const totals = slips.reduce(
    (acc, s) => ({
      totalGrossPaise: acc.totalGrossPaise + s.grossPaise,
      totalLopPaise: acc.totalLopPaise + s.lopDeductionPaise,
      totalTaxPaise: acc.totalTaxPaise + s.finalTaxPaise,
      totalNetPaise: acc.totalNetPaise + s.netPayPaise,
    }),
    { totalGrossPaise: 0, totalLopPaise: 0, totalTaxPaise: 0, totalNetPaise: 0 },
  );

  return {
    id: run.id,
    code: run.code,
    month: run.month,
    year: run.year,
    status: run.status,
    workingDays: run.workingDays,
    periodStart: run.periodStart.toISOString().split('T')[0]!,
    periodEnd: run.periodEnd.toISOString().split('T')[0]!,
    initiatedBy: run.initiatedBy,
    initiatedByName: run.initiator.name,
    initiatedAt: run.createdAt.toISOString(),
    finalisedBy: run.finalisedBy,
    finalisedByName: run.finaliser?.name ?? null,
    finalisedAt: run.finalisedAt?.toISOString() ?? null,
    reversedBy: run.reversedBy,
    reversedByName: run.reverser?.name ?? null,
    reversedAt: run.reversedAt?.toISOString() ?? null,
    reversalReason: run.reversalReason,
    reversalOfRunId: run.reversalOfRunId,
    employeeCount: slips.length,
    ...totals,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    version: run.version,
  };
}

/** Format a Payslip row for the API response. */
function formatPayslip(
  slip: {
    id: string;
    code: string;
    runId: string;
    run: { code: string };
    employeeId: string;
    employee: { name: string; code: string; designation: string | null; department: string | null };
    month: number;
    year: number;
    status: string;
    periodStart: Date;
    periodEnd: Date;
    workingDays: number;
    daysWorked: number;
    lopDays: number;
    basicPaise: number;
    allowancesPaise: number;
    grossPaise: number;
    lopDeductionPaise: number;
    referenceTaxPaise: number;
    finalTaxPaise: number;
    otherDeductionsPaise: number;
    netPayPaise: number;
    finalisedAt: Date | null;
    reversalOfPayslipId: string | null;
    reversedByPayslipId: string | null;
    createdAt: Date;
    updatedAt: Date;
    version: number;
  },
) {
  return {
    id: slip.id,
    code: slip.code,
    runId: slip.runId,
    runCode: slip.run.code,
    employeeId: slip.employeeId,
    employeeName: slip.employee.name,
    employeeCode: slip.employee.code,
    designation: slip.employee.designation,
    department: slip.employee.department,
    month: slip.month,
    year: slip.year,
    status: slip.status,
    periodStart: slip.periodStart.toISOString().split('T')[0]!,
    periodEnd: slip.periodEnd.toISOString().split('T')[0]!,
    workingDays: slip.workingDays,
    daysWorked: slip.daysWorked,
    lopDays: slip.lopDays,
    basicPaise: slip.basicPaise,
    allowancesPaise: slip.allowancesPaise,
    grossPaise: slip.grossPaise,
    lopDeductionPaise: slip.lopDeductionPaise,
    referenceTaxPaise: slip.referenceTaxPaise,
    finalTaxPaise: slip.finalTaxPaise,
    otherDeductionsPaise: slip.otherDeductionsPaise,
    netPayPaise: slip.netPayPaise,
    finalisedAt: slip.finalisedAt?.toISOString() ?? null,
    reversalOfPayslipId: slip.reversalOfPayslipId,
    reversedByPayslipId: slip.reversedByPayslipId,
    createdAt: slip.createdAt.toISOString(),
    updatedAt: slip.updatedAt.toISOString(),
    version: slip.version,
  };
}

const runInclude = {
  initiator: { select: { name: true } },
  finaliser: { select: { name: true } },
  reverser: { select: { name: true } },
  payslips: {
    select: {
      grossPaise: true,
      lopDeductionPaise: true,
      finalTaxPaise: true,
      netPayPaise: true,
    },
  },
} as const;

const slipInclude = {
  run: { select: { code: true } },
  employee: { select: { name: true, code: true, designation: true, department: true } },
} as const;

// ── POST /payroll/runs ────────────────────────────────────────────────────────

payrollRouter.post(
  '/runs',
  requireSession(),
  requireRole('Admin', 'PayrollOfficer'),
  idempotencyKey(),
  validateBody(CreatePayrollRunRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { month, year, workingDays: overrideWd } = req.body as {
      month: number;
      year: number;
      workingDays?: number;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type TxErr = Error & { statusCode?: number; code?: string; ruleId?: string; details?: Record<string, any> };

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        // Check for an existing non-Reversed run for this month+year.
        // SEC-P8-007: The application-layer check here is the first line of defense.
        // The DB unique constraint @@unique([month, year, reversalOfRunId]) on payroll_runs
        // is the defense-in-depth — if two concurrent requests both pass this check before
        // either inserts, exactly one wins and the other gets a Prisma P2002 unique-constraint
        // violation which is caught below and returned as RUN_ALREADY_EXISTS.
        const existing = await tx.payrollRun.findFirst({
          where: {
            month,
            year,
            reversalOfRunId: null,
            status: { not: 'Reversed' },
          },
        });

        if (existing) {
          const e: TxErr = new Error(
            `A payroll run already exists for ${year}-${String(month).padStart(2, '0')} (code: ${existing.code}, status: ${existing.status}).`,
          );
          e.statusCode = 409;
          e.code = ErrorCode.RUN_ALREADY_EXISTS;
          throw e;
        }

        // Compute working days
        const wdResult = await computeWorkingDays(month, year, tx);
        const workingDays = overrideWd ?? wdResult.workingDays;
        const { periodStart, periodEnd } = wdResult;

        // Generate run code
        const runCode = await generateRunCode(year, month, tx);

        // Read tax reference rate
        const taxConfig = await tx.configuration.findUnique({
          where: { key: 'STANDARD_TAX_REFERENCE_RATE' },
        });
        const referenceRate = (taxConfig?.value as number) ?? 0.095;

        // Create the run row (status=Review — PO can edit taxes immediately)
        const run = await tx.payrollRun.create({
          data: {
            code: runCode,
            month,
            year,
            status: 'Review',
            workingDays,
            periodStart,
            periodEnd,
            initiatedBy: user.id,
            version: 0,
          },
        });

        // Fetch all Active or On-Notice employees
        const employees = await tx.employee.findMany({
          where: { status: { in: ['Active', 'OnNotice'] } },
        });

        let payslipCount = 0;
        const skipped: string[] = [];

        for (const emp of employees) {
          try {
            const values = await computePayslip(emp, run, referenceRate, tx);

            await tx.payslip.create({
              data: {
                code: values.code,
                runId: run.id,
                employeeId: emp.id,
                month: values.month,
                year: values.year,
                status: 'Review',
                periodStart: values.periodStart,
                periodEnd: values.periodEnd,
                workingDays: values.workingDays,
                daysWorked: values.daysWorked,
                lopDays: values.lopDays,
                basicPaise: values.basicPaise,
                allowancesPaise: values.allowancesPaise,
                grossPaise: values.grossPaise,
                lopDeductionPaise: values.lopDeductionPaise,
                referenceTaxPaise: values.referenceTaxPaise,
                finalTaxPaise: values.finalTaxPaise,
                otherDeductionsPaise: values.otherDeductionsPaise,
                netPayPaise: values.netPayPaise,
                version: 0,
              },
            });

            payslipCount++;
          } catch (empErr: unknown) {
            // Employee with no salary structure — skip with a warning
            skipped.push(emp.code);
            logger.warn(
              { empCode: emp.code, err: empErr },
              'payroll.run.create: skipping employee — no active salary structure',
            );
          }
        }

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.role,
          actorIp: req.ip ?? null,
          action: 'payroll.run.create',
          targetType: 'PayrollRun',
          targetId: run.id,
          module: 'payroll',
          before: null,
          after: {
            code: run.code,
            month,
            year,
            workingDays,
            status: 'Review',
            payslipCount,
            skipped,
          },
        });

        return { run, payslipCount };
      });
    } catch (err: unknown) {
      const txErr = err as TxErr;
      if (txErr.statusCode && txErr.code) {
        res
          .status(txErr.statusCode)
          .json(errorEnvelope(txErr.code, txErr.message, { ruleId: txErr.ruleId, details: txErr.details }));
        return;
      }
      // SEC-P8-007: DB unique constraint fallback — two concurrent creates raced past the
      // application-layer check. The DB unique index on (month, year, reversalOfRunId) caught
      // the duplicate. Return a named RUN_ALREADY_EXISTS rather than a 500.
      const prismaErr = err as { code?: string };
      if (prismaErr.code === 'P2002') {
        res.status(409).json(
          errorEnvelope(
            ErrorCode.RUN_ALREADY_EXISTS,
            `A payroll run already exists for ${year}-${String(month).padStart(2, '0')}.`,
          ),
        );
        return;
      }
      throw err;
    }

    // Re-fetch run with full includes for the response
    const fullRun = await prisma.payrollRun.findUnique({
      where: { id: result.run.id },
      include: runInclude,
    });

    if (!fullRun) {
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load created run.'));
      return;
    }

    // Notify all PayrollOfficer employees about the new run (batched, outside tx)
    const payrollOfficers = await prisma.employee.findMany({
      where: { role: 'PayrollOfficer', status: 'Active' },
      select: { id: true },
    });
    if (payrollOfficers.length > 0) {
      const monthLabel = `${result.run.year}-${String(result.run.month).padStart(2, '0')}`;
      await notify({
        recipientIds: payrollOfficers.map((p) => p.id),
        category: 'Payroll',
        title: `New payroll run ${result.run.code} ready for review`,
        body: `Payroll run ${result.run.code} for ${monthLabel} has been created and is ready for tax review.`,
        link: `/payroll/payroll-runs/${result.run.id}`,
      });
    }

    // Notify all Active employees that payroll is being processed
    const activeEmployees = await prisma.employee.findMany({
      where: { status: { in: ['Active', 'OnNotice'] } },
      select: { id: true },
    });
    if (activeEmployees.length > 0) {
      const monthLabel = new Date(result.run.year, result.run.month - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
      await notify({
        recipientIds: activeEmployees.map((e) => e.id),
        category: 'Payroll',
        title: `Payroll for ${monthLabel} is being processed`,
        body: `The payroll run for ${monthLabel} has started. Your payslip will be available once finalised.`,
      });
    }

    res.status(201).json({
      data: {
        run: formatRun(fullRun),
        payslipCount: result.payslipCount,
      },
    });
  },
);

// ── GET /payroll/runs ─────────────────────────────────────────────────────────

payrollRouter.get(
  '/runs',
  requireSession(),
  requireRole('Admin', 'PayrollOfficer'),
  validateQuery(PayrollRunListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const { year, status, cursor, limit } = req.query as {
      year?: number;
      status?: string;
      cursor?: string;
      limit?: number;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {};
    if (year) where['year'] = Number(year);
    if (status) where['status'] = status;
    if (cursor) where['id'] = { gt: cursor };

    const runs = await prisma.payrollRun.findMany({
      where,
      orderBy: [{ year: 'desc' }, { month: 'desc' }, { createdAt: 'desc' }],
      take: (Number(limit) || 20) + 1,
      include: {
        initiator: { select: { name: true } },
        payslips: {
          select: {
            grossPaise: true,
            lopDeductionPaise: true,
            finalTaxPaise: true,
            netPayPaise: true,
          },
        },
      },
    });

    const hasMore = runs.length > (Number(limit) || 20);
    const page = hasMore ? runs.slice(0, Number(limit) || 20) : runs;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    const formatted = page.map((r) => ({
      id: r.id,
      code: r.code,
      month: r.month,
      year: r.year,
      status: r.status,
      initiatedByName: r.initiator.name,
      finalisedAt: r.finalisedAt?.toISOString() ?? null,
      employeeCount: r.payslips.length,
      totalGrossPaise: r.payslips.reduce((s, p) => s + p.grossPaise, 0),
      totalNetPaise: r.payslips.reduce((s, p) => s + p.netPayPaise, 0),
      reversalOfRunId: r.reversalOfRunId,
      createdAt: r.createdAt.toISOString(),
    }));

    res.status(200).json({ data: formatted, nextCursor });
  },
);

// ── GET /payroll/runs/:id ─────────────────────────────────────────────────────

payrollRouter.get(
  '/runs/:id',
  requireSession(),
  requireRole('Admin', 'PayrollOfficer'),
  async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;

    const run = await prisma.payrollRun.findUnique({
      where: { id },
      include: {
        ...runInclude,
        payslips: {
          include: slipInclude,
        },
      },
    });

    if (!run) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payroll run not found.'));
      return;
    }

    // Build payslip summaries
    const payslipSummaries = run.payslips.map((s) => ({
      id: s.id,
      code: s.code,
      runId: s.runId,
      employeeId: s.employeeId,
      employeeName: s.employee.name,
      employeeCode: s.employee.code,
      month: s.month,
      year: s.year,
      status: s.status,
      workingDays: s.workingDays,
      lopDays: s.lopDays,
      grossPaise: s.grossPaise,
      finalTaxPaise: s.finalTaxPaise,
      netPayPaise: s.netPayPaise,
      finalisedAt: s.finalisedAt?.toISOString() ?? null,
      reversalOfPayslipId: s.reversalOfPayslipId,
    }));

    // Re-format run using payslip aggregates
    const runFormatted = formatRun({
      ...run,
      payslips: run.payslips.map((s) => ({
        grossPaise: s.grossPaise,
        lopDeductionPaise: s.lopDeductionPaise,
        finalTaxPaise: s.finalTaxPaise,
        netPayPaise: s.netPayPaise,
      })),
    });

    res.status(200).json({ data: { run: runFormatted, payslips: payslipSummaries } });
  },
);

// ── POST /payroll/runs/:id/finalise ───────────────────────────────────────────

payrollRouter.post(
  '/runs/:id/finalise',
  requireSession(),
  requireRole('Admin', 'PayrollOfficer'),
  idempotencyKey(),
  validateBody(FinaliseRunRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = req.params['id'] as string;
    const { version } = req.body as { confirm: 'FINALISE'; version: number };

    let finalisedRun;

    try {
      finalisedRun = await prisma.$transaction(async (tx) => {
        // BL-034: acquire row-level lock
        const locked = await acquireRunLock(id, tx);

        if (!locked) {
          const e = new Error('Payroll run not found.') as Error & { statusCode: number; code: string };
          e.statusCode = 404;
          e.code = ErrorCode.NOT_FOUND;
          throw e;
        }

        // Re-check status post-lock
        if (locked.status === 'Finalised') {
          // Another caller already finalised this run
          const winner = await tx.employee.findUnique({
            where: { id: locked.finalisedBy! },
            select: { id: true, name: true },
          });

          const e = new Error('This payroll run has already been finalised.') as Error & {
            statusCode: number;
            code: string;
            ruleId: string;
            details: Record<string, unknown>;
          };
          e.statusCode = 409;
          e.code = ErrorCode.RUN_ALREADY_FINALISED;
          e.ruleId = 'BL-034';
          e.details = {
            winnerId: locked.finalisedBy!,
            winnerName: winner?.name ?? 'Unknown',
            winnerAt: locked.finalisedAt!.toISOString(),
          };
          throw e;
        }

        if (locked.status !== 'Review' && locked.status !== 'Draft') {
          const e = new Error(`Run cannot be finalised from status '${locked.status}'.`) as Error & {
            statusCode: number;
            code: string;
          };
          e.statusCode = 409;
          e.code = ErrorCode.VALIDATION_FAILED;
          throw e;
        }

        // Optimistic concurrency check
        if (locked.version !== version) {
          const e = new Error('The run has been modified. Please refresh and retry.') as Error & {
            statusCode: number;
            code: string;
          };
          e.statusCode = 409;
          e.code = ErrorCode.VERSION_MISMATCH;
          throw e;
        }

        const now = new Date();

        // Update run status
        const updated = await tx.payrollRun.update({
          where: { id },
          data: {
            status: 'Finalised',
            finalisedBy: user.id,
            finalisedAt: now,
            version: { increment: 1 },
          },
          include: runInclude,
        });

        // Update all payslips (BL-031: they become immutable after this)
        await tx.payslip.updateMany({
          where: { runId: id },
          data: {
            status: 'Finalised',
            finalisedAt: now,
          },
        });

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.role,
          actorIp: req.ip ?? null,
          action: 'payroll.run.finalise',
          targetType: 'PayrollRun',
          targetId: id,
          module: 'payroll',
          before: { status: locked.status, version: locked.version },
          after: { status: 'Finalised', finalisedAt: now.toISOString(), finalisedBy: user.id },
        });

        return updated;
      });
    } catch (err: unknown) {
      const txErr = err as Error & {
        statusCode?: number;
        code?: string;
        ruleId?: string;
        details?: Record<string, unknown>;
      };
      if (txErr.statusCode && txErr.code) {
        res
          .status(txErr.statusCode)
          .json(
            errorEnvelope(txErr.code, txErr.message, {
              ruleId: txErr.ruleId,
              details: txErr.details,
            }),
          );
        return;
      }
      throw err;
    }

    // Re-fetch with aggregates
    const fullRun = await prisma.payrollRun.findUnique({
      where: { id },
      include: runInclude,
    });

    // Notify all employees whose payslip was in this run that it's ready
    const finalizedPayslips = await prisma.payslip.findMany({
      where: { runId: id, status: 'Finalised', reversalOfPayslipId: null },
      select: { id: true, employeeId: true, month: true, year: true },
    });

    if (finalizedPayslips.length > 0) {
      // Fan-out: one notification per employee payslip
      const monthLabel = new Date(finalizedPayslips[0]!.year, finalizedPayslips[0]!.month - 1, 1)
        .toLocaleString('en-IN', { month: 'long', year: 'numeric' });

      await Promise.all(
        finalizedPayslips.map((slip) =>
          notify({
            recipientIds: slip.employeeId,
            category: 'Payroll',
            title: `Your payslip for ${monthLabel} is ready`,
            body: `Your payslip for ${monthLabel} has been finalised. You can view and download it now.`,
            link: `/employee/payslips/${slip.id}`,
          }),
        ),
      );
    }

    res.status(200).json({ data: { run: formatRun(fullRun ?? finalisedRun) } });
  },
);

// ── POST /payroll/runs/:id/reverse ────────────────────────────────────────────

payrollRouter.post(
  '/runs/:id/reverse',
  requireSession(),
  requireRole('Admin'),  // BL-033: only Admin can reverse
  idempotencyKey(),
  validateBody(ReverseRunRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const sourceId = req.params['id'] as string;
    const { reason } = req.body as { confirm: 'REVERSE'; reason: string };

    let result;

    try {
      result = await prisma.$transaction(async (tx) => {
        // Acquire row lock on source run
        const locked = await acquireRunLock(sourceId, tx);

        if (!locked) {
          const e = new Error('Payroll run not found.') as Error & { statusCode: number; code: string };
          e.statusCode = 404;
          e.code = ErrorCode.NOT_FOUND;
          throw e;
        }

        if (locked.status !== 'Finalised') {
          const e = new Error(
            `Only Finalised runs can be reversed. Current status: '${locked.status}'.`,
          ) as Error & { statusCode: number; code: string };
          e.statusCode = 409;
          e.code = ErrorCode.VALIDATION_FAILED;
          throw e;
        }

        // Load full source run
        const sourceRun = await tx.payrollRun.findUnique({
          where: { id: sourceId },
          select: { id: true, code: true, month: true, year: true, workingDays: true, periodStart: true, periodEnd: true },
        });

        if (!sourceRun) {
          const e = new Error('Payroll run not found.') as Error & { statusCode: number; code: string };
          e.statusCode = 404;
          e.code = ErrorCode.NOT_FOUND;
          throw e;
        }

        // Count prior reversals for this run to generate R<n> code
        const priorReversals = await tx.payrollRun.count({
          where: { reversalOfRunId: sourceId },
        });

        const reversalCode = generateReversalRunCode(sourceRun.code, priorReversals);
        const now = new Date();

        // Create reversal run (BL-032: source run is NOT modified)
        const reversalRun = await tx.payrollRun.create({
          data: {
            code: reversalCode,
            month: sourceRun.month,
            year: sourceRun.year,
            status: 'Reversed',
            workingDays: sourceRun.workingDays,
            periodStart: sourceRun.periodStart,
            periodEnd: sourceRun.periodEnd,
            initiatedBy: user.id,
            reversedBy: user.id,
            reversedAt: now,
            reversalReason: reason,
            reversalOfRunId: sourceId,
            version: 0,
          },
        });

        // Fetch all source payslips
        const sourceSlips = await tx.payslip.findMany({
          where: { runId: sourceId, reversalOfPayslipId: null },
        });

        let payslipCount = 0;

        for (const slip of sourceSlips) {
          // Generate reversal payslip code
          const revSlipCode = await generatePayslipCode(
            sourceRun.year,
            sourceRun.month,
            tx,
          );

          // Create reversal payslip (identical money values — UI/PO reads signs)
          const revSlip = await tx.payslip.create({
            data: {
              code: revSlipCode,
              runId: reversalRun.id,
              employeeId: slip.employeeId,
              month: slip.month,
              year: slip.year,
              status: 'Reversed',
              periodStart: slip.periodStart,
              periodEnd: slip.periodEnd,
              workingDays: slip.workingDays,
              daysWorked: slip.daysWorked,
              lopDays: slip.lopDays,
              basicPaise: slip.basicPaise,
              allowancesPaise: slip.allowancesPaise,
              grossPaise: slip.grossPaise,
              lopDeductionPaise: slip.lopDeductionPaise,
              referenceTaxPaise: slip.referenceTaxPaise,
              finalTaxPaise: slip.finalTaxPaise,
              otherDeductionsPaise: slip.otherDeductionsPaise,
              netPayPaise: slip.netPayPaise,
              finalisedAt: slip.finalisedAt,
              reversalOfPayslipId: slip.id,
              version: 0,
            },
          });

          // Point the source payslip to its reversal record (BL-032)
          await tx.payslip.update({
            where: { id: slip.id },
            data: { reversedByPayslipId: revSlip.id },
          });

          payslipCount++;
        }

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.role,
          actorIp: req.ip ?? null,
          action: 'payroll.run.reverse',
          targetType: 'PayrollRun',
          targetId: reversalRun.id,
          module: 'payroll',
          before: { sourceRunId: sourceId, sourceRunCode: sourceRun.code },
          after: {
            reversalRunCode: reversalCode,
            reversalRunId: reversalRun.id,
            reason,
            payslipCount,
          },
        });

        return { reversalRun, payslipCount };
      });
    } catch (err: unknown) {
      const txErr = err as Error & { statusCode?: number; code?: string };
      if (txErr.statusCode && txErr.code) {
        res.status(txErr.statusCode).json(errorEnvelope(txErr.code, txErr.message));
        return;
      }
      throw err;
    }

    // Fetch full run with aggregates for the response
    const fullReversalRun = await prisma.payrollRun.findUnique({
      where: { id: result.reversalRun.id },
      include: runInclude,
    });

    if (!fullReversalRun) {
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to load reversal run.'));
      return;
    }

    // Notify Admins + affected employees about the reversal
    const [admins, reversalPayslips] = await Promise.all([
      prisma.employee.findMany({ where: { role: 'Admin', status: 'Active' }, select: { id: true } }),
      prisma.payslip.findMany({
        where: { runId: result.reversalRun.id },
        select: { employeeId: true },
      }),
    ]);

    const adminIds = admins.map((a) => a.id);
    const affectedEmployeeIds = Array.from(new Set(reversalPayslips.map((s) => s.employeeId)));
    const monthLabel = new Date(result.reversalRun.year, result.reversalRun.month - 1, 1)
      .toLocaleString('en-IN', { month: 'long', year: 'numeric' });

    const allReversalRecipients = Array.from(new Set([...adminIds, ...affectedEmployeeIds]));
    if (allReversalRecipients.length > 0) {
      await notify({
        recipientIds: allReversalRecipients,
        category: 'Payroll',
        title: `Payroll for ${monthLabel} was reversed`,
        body: `Payroll run ${result.reversalRun.code} for ${monthLabel} was reversed by Admin: ${reason}.`,
        link: `/payroll/payroll-runs/${result.reversalRun.id}`,
      });
    }

    res.status(201).json({
      data: {
        reversalRun: formatRun(fullReversalRun),
        payslipCount: result.payslipCount,
      },
    });
  },
);

// ── GET /payroll/reversals ────────────────────────────────────────────────────

payrollRouter.get(
  '/reversals',
  requireSession(),
  requireRole('Admin', 'PayrollOfficer'),
  validateQuery(PaginationQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const { cursor, limit } = req.query as { cursor?: string; limit?: number };
    const take = (Number(limit) || 20) + 1;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = { reversalOfRunId: { not: null } };
    if (cursor) where['id'] = { gt: cursor };

    const reversals = await prisma.payrollRun.findMany({
      where,
      orderBy: { reversedAt: 'desc' },
      take,
      include: {
        reverser: { select: { name: true } },
        reversalOf: { select: { code: true } },
        payslips: { select: { netPayPaise: true } },
      },
    });

    const hasMore = reversals.length > (Number(limit) || 20);
    const page = hasMore ? reversals.slice(0, Number(limit) || 20) : reversals;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    const formatted = page.map((r) => ({
      reversalRunId: r.id,
      reversalRunCode: r.code,
      originalRunId: r.reversalOfRunId!,
      originalRunCode: r.reversalOf?.code ?? '',
      month: r.month,
      year: r.year,
      reversedBy: r.reversedBy ?? '',
      reversedByName: r.reverser?.name ?? '',
      reversedAt: r.reversedAt?.toISOString() ?? r.createdAt.toISOString(),
      reason: r.reversalReason ?? '',
      affectedEmployees: r.payslips.length,
      // Net adjustment is negative for reversals (represents money returned)
      netAdjustmentPaise: -r.payslips.reduce((s, p) => s + p.netPayPaise, 0),
    }));

    res.status(200).json({ data: formatted, nextCursor });
  },
);

// ── GET /payslips ─────────────────────────────────────────────────────────────

payslipsRouter.get(
  '/',
  requireSession(),
  validateQuery(PayslipListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { year, month, employeeId, status, runId, isReversal, cursor, limit } =
      req.query as {
        year?: number;
        month?: number;
        employeeId?: string;
        status?: string;
        runId?: string;
        isReversal?: boolean;
        cursor?: string;
        limit?: number;
      };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {};

    // Scope by role
    if (user.role === 'Employee') {
      where['employeeId'] = user.id;
    } else if (user.role === 'Manager') {
      const subs = await getSubordinateIds(user.id);
      const allowed = [user.id, ...subs];
      if (employeeId) {
        if (!allowed.includes(employeeId)) {
          res.status(200).json({ data: [], nextCursor: null });
          return;
        }
        where['employeeId'] = employeeId;
      } else {
        where['employeeId'] = { in: allowed };
      }
    } else {
      // Admin / PayrollOfficer — see all
      if (employeeId) where['employeeId'] = employeeId;
    }

    if (year) where['year'] = Number(year);
    if (month) where['month'] = Number(month);
    if (status) where['status'] = status;
    // BUG-PAY-004 fix — `runId` is a documented filter; was previously dropped.
    if (runId) where['runId'] = runId;
    if (isReversal !== undefined) {
      where['reversalOfPayslipId'] = isReversal ? { not: null } : null;
    }
    if (cursor) where['id'] = { gt: cursor };

    const slips = await prisma.payslip.findMany({
      where,
      orderBy: [{ year: 'desc' }, { month: 'desc' }, { createdAt: 'desc' }],
      take: (Number(limit) || 20) + 1,
      include: slipInclude,
    });

    const hasMore = slips.length > (Number(limit) || 20);
    const page = hasMore ? slips.slice(0, Number(limit) || 20) : slips;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    const summaries = page.map((s) => ({
      id: s.id,
      code: s.code,
      runId: s.runId,
      employeeId: s.employeeId,
      employeeName: s.employee.name,
      employeeCode: s.employee.code,
      month: s.month,
      year: s.year,
      status: s.status,
      workingDays: s.workingDays,
      lopDays: s.lopDays,
      grossPaise: s.grossPaise,
      finalTaxPaise: s.finalTaxPaise,
      netPayPaise: s.netPayPaise,
      finalisedAt: s.finalisedAt?.toISOString() ?? null,
      reversalOfPayslipId: s.reversalOfPayslipId,
    }));

    res.status(200).json({ data: summaries, nextCursor });
  },
);

// ── GET /payslips/:id ─────────────────────────────────────────────────────────

payslipsRouter.get(
  '/:id',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = req.params['id'] as string;

    const slip = await prisma.payslip.findUnique({
      where: { id },
      include: slipInclude,
    });

    if (!slip) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }

    // Visibility check
    const canSee = await canViewPayslip(user.id, user.role, slip.employeeId);
    if (!canSee) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }

    res.status(200).json({ data: formatPayslip(slip) });
  },
);

// ── PATCH /payslips/:id/tax ───────────────────────────────────────────────────

payslipsRouter.patch(
  '/:id/tax',
  requireSession(),
  requireRole('Admin', 'PayrollOfficer'),
  idempotencyKey(),
  validateBody(UpdatePayslipTaxRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = req.params['id'] as string;
    const { finalTaxPaise: newTax, version } = req.body as {
      finalTaxPaise: number;
      version: number;
    };

    const slip = await prisma.payslip.findUnique({
      where: { id },
      include: { run: { select: { status: true } } },
    });

    if (!slip) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }

    // BL-031: reject if payslip is Finalised or Reversed
    if (slip.status === 'Finalised' || slip.status === 'Reversed') {
      res.status(409).json(
        errorEnvelope(ErrorCode.PAYSLIP_IMMUTABLE, 'This payslip is finalised and cannot be modified.', {
          ruleId: 'BL-031',
        }),
      );
      return;
    }

    // Run must be in a mutable state (Draft or Review)
    if (slip.run.status === 'Finalised' || slip.run.status === 'Reversed') {
      res.status(409).json(
        errorEnvelope(ErrorCode.PAYSLIP_IMMUTABLE, 'The parent run is finalised. Payslip cannot be modified.', {
          ruleId: 'BL-031',
        }),
      );
      return;
    }

    // Optimistic concurrency
    if (slip.version !== version) {
      res.status(409).json(
        errorEnvelope(ErrorCode.VERSION_MISMATCH, 'The payslip has been modified. Please refresh and retry.'),
      );
      return;
    }

    const newNet = recomputeNet(
      slip.grossPaise,
      slip.lopDeductionPaise,
      newTax,
      slip.otherDeductionsPaise,
    );

    const before = { finalTaxPaise: slip.finalTaxPaise, netPayPaise: slip.netPayPaise };

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.payslip.update({
        where: { id },
        data: {
          finalTaxPaise: newTax,
          netPayPaise: newNet,
          version: { increment: 1 },
        },
        include: slipInclude,
      });

      await audit({
        tx,
        actorId: user.id,
        actorRole: user.role,
        actorIp: req.ip ?? null,
        action: 'payslip.tax.update',
        targetType: 'Payslip',
        targetId: id,
        module: 'payroll',
        before,
        after: { finalTaxPaise: newTax, netPayPaise: newNet },
      });

      return u;
    });

    res.status(200).json({ data: formatPayslip(updated) });
  },
);

// ── GET /payslips/:id/pdf ─────────────────────────────────────────────────────

payslipsRouter.get(
  '/:id/pdf',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const id = req.params['id'] as string;

    const slip = await prisma.payslip.findUnique({
      where: { id },
      include: slipInclude,
    });

    if (!slip) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }

    const canSee = await canViewPayslip(user.id, user.role, slip.employeeId);
    if (!canSee) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }

    streamPayslipPDF(
      {
        code: slip.code,
        month: slip.month,
        year: slip.year,
        status: slip.status,
        periodStart: slip.periodStart.toISOString().split('T')[0]!,
        periodEnd: slip.periodEnd.toISOString().split('T')[0]!,
        workingDays: slip.workingDays,
        daysWorked: slip.daysWorked,
        lopDays: slip.lopDays,
        basicPaise: slip.basicPaise,
        allowancesPaise: slip.allowancesPaise,
        grossPaise: slip.grossPaise,
        lopDeductionPaise: slip.lopDeductionPaise,
        referenceTaxPaise: slip.referenceTaxPaise,
        finalTaxPaise: slip.finalTaxPaise,
        otherDeductionsPaise: slip.otherDeductionsPaise,
        netPayPaise: slip.netPayPaise,
        finalisedAt: slip.finalisedAt?.toISOString() ?? null,
        reversalOfPayslipId: slip.reversalOfPayslipId,
        employeeName: slip.employee.name,
        employeeCode: slip.employee.code,
        designation: slip.employee.designation,
        department: slip.employee.department,
        runCode: slip.run.code,
      },
      res,
    );
  },
);

// ── Tax config ────────────────────────────────────────────────────────────────

// Default basis used when the Configuration row is absent (pre-seed installs).
const DEFAULT_GROSS_TAXABLE_BASIS = 'GrossMinusStandardDeduction' as const;
type GrossTaxableBasisValue =
  | 'GrossMinusStandardDeduction'
  | 'GrossFull'
  | 'BasicOnly';

function coerceBasis(raw: unknown): GrossTaxableBasisValue {
  return raw === 'GrossFull' || raw === 'BasicOnly' || raw === 'GrossMinusStandardDeduction'
    ? (raw as GrossTaxableBasisValue)
    : DEFAULT_GROSS_TAXABLE_BASIS;
}

// GET /config/tax
taxConfigRouter.get(
  '/',
  requireSession(),
  requireRole('Admin'),
  async (_req: Request, res: Response): Promise<void> => {
    const [rateRow, basisRow] = await Promise.all([
      prisma.configuration.findUnique({
        where: { key: 'STANDARD_TAX_REFERENCE_RATE' },
      }),
      prisma.configuration.findUnique({
        where: { key: 'TAX_GROSS_TAXABLE_BASIS' },
      }),
    ]);

    // The most recently touched of the two rows wins for updatedBy/updatedAt.
    const newest =
      rateRow && basisRow
        ? rateRow.updatedAt >= basisRow.updatedAt
          ? rateRow
          : basisRow
        : (rateRow ?? basisRow ?? null);

    res.status(200).json({
      data: {
        referenceRate: (rateRow?.value as number) ?? 0.095,
        grossTaxableBasis: coerceBasis(basisRow?.value),
        updatedBy: newest?.updatedBy ?? null,
        updatedAt: newest?.updatedAt?.toISOString() ?? null,
      },
    });
  },
);

// PATCH /config/tax — partial body; rate and basis can be saved independently.
taxConfigRouter.patch(
  '/',
  requireSession(),
  requireRole('Admin'),
  idempotencyKey(),
  validateBody(UpdateTaxSettingsRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { referenceRate, grossTaxableBasis } = req.body as {
      referenceRate?: number;
      grossTaxableBasis?: GrossTaxableBasisValue;
    };

    const [beforeRate, beforeBasis] = await Promise.all([
      prisma.configuration.findUnique({
        where: { key: 'STANDARD_TAX_REFERENCE_RATE' },
      }),
      prisma.configuration.findUnique({
        where: { key: 'TAX_GROSS_TAXABLE_BASIS' },
      }),
    ]);

    const { rateRow, basisRow } = await prisma.$transaction(async (tx) => {
      let nextRateRow = beforeRate;
      let nextBasisRow = beforeBasis;

      if (referenceRate !== undefined) {
        nextRateRow = await tx.configuration.upsert({
          where: { key: 'STANDARD_TAX_REFERENCE_RATE' },
          create: {
            key: 'STANDARD_TAX_REFERENCE_RATE',
            value: referenceRate,
            updatedBy: user.id,
          },
          update: {
            value: referenceRate,
            updatedBy: user.id,
          },
        });

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.role,
          actorIp: req.ip ?? null,
          action: 'config.tax.update',
          targetType: 'Configuration',
          targetId: 'STANDARD_TAX_REFERENCE_RATE',
          module: 'payroll',
          before: { referenceRate: (beforeRate?.value as number) ?? null },
          after: { referenceRate },
        });
      }

      if (grossTaxableBasis !== undefined) {
        nextBasisRow = await tx.configuration.upsert({
          where: { key: 'TAX_GROSS_TAXABLE_BASIS' },
          create: {
            key: 'TAX_GROSS_TAXABLE_BASIS',
            value: grossTaxableBasis,
            updatedBy: user.id,
          },
          update: {
            value: grossTaxableBasis,
            updatedBy: user.id,
          },
        });

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.role,
          actorIp: req.ip ?? null,
          action: 'config.tax.update',
          targetType: 'Configuration',
          targetId: 'TAX_GROSS_TAXABLE_BASIS',
          module: 'payroll',
          before: { grossTaxableBasis: coerceBasis(beforeBasis?.value) },
          after: { grossTaxableBasis },
        });
      }

      return { rateRow: nextRateRow, basisRow: nextBasisRow };
    });

    // Notify all PayrollOfficers if the reference rate changed. Basis-only
    // changes do not affect the live reference figure today (v1 engine
    // ignores the basis) — skip the notify to avoid noise.
    if (referenceRate !== undefined) {
      const payrollOfficers = await prisma.employee.findMany({
        where: { role: 'PayrollOfficer', status: 'Active' },
        select: { id: true },
      });
      if (payrollOfficers.length > 0) {
        const ratePercent = (referenceRate * 100).toFixed(2);
        await notify({
          recipientIds: payrollOfficers.map((p) => p.id),
          category: 'Configuration',
          title: `Tax reference rate changed to ${ratePercent}%`,
          body: `The standard tax reference rate has been updated to ${ratePercent}% by Admin.`,
          link: '/payroll/config/tax',
        });
      }
    }

    const newest =
      rateRow && basisRow
        ? rateRow.updatedAt >= basisRow.updatedAt
          ? rateRow
          : basisRow
        : (rateRow ?? basisRow ?? null);

    res.status(200).json({
      data: {
        referenceRate: (rateRow?.value as number) ?? 0.095,
        grossTaxableBasis: coerceBasis(basisRow?.value),
        updatedBy: newest?.updatedBy ?? null,
        updatedAt: newest?.updatedAt?.toISOString() ?? null,
      },
    });
  },
);

// ── Visibility helpers ────────────────────────────────────────────────────────

/**
 * Returns true if the calling user is allowed to see a payslip for the
 * given employeeId.
 *
 * Rules:
 *   - Employee: own payslip only
 *   - Manager: own + subordinate tree
 *   - PayrollOfficer / Admin: all
 */
async function canViewPayslip(
  userId: string,
  userRole: string,
  ownerId: string,
): Promise<boolean> {
  if (userRole === 'Admin' || userRole === 'PayrollOfficer') return true;
  if (userId === ownerId) return true;

  if (userRole === 'Manager') {
    const subs = await getSubordinateIds(userId);
    return subs.includes(ownerId);
  }

  return false;
}
