/**
 * Payroll routes — v2 schema (INT IDs, INT status codes).
 *
 * Mounted at /api/v1/ (three sub-routers merged here for clean grouping):
 *   payrollRouter   → /api/v1/payroll/*
 *   payslipsRouter  → /api/v1/payslips/*
 *   taxConfigRouter → /api/v1/config/tax
 *
 * Run state model (simplified from SRS):
 *   STATUS GATE: Run is created with status=Review (INT 2).
 *   Rationale: PO can edit tax until Finalise. 'Draft' is reserved for future phases.
 *
 * BL-034 concurrency guard: finalise and reverse both use SELECT … FOR UPDATE
 * inside a Prisma interactive transaction to prevent two simultaneous callers
 * from finalising/reversing the same run.
 *
 * BL-031 / BL-032: finalised payslips' financial fields are NEVER updated;
 * reversals create new rows. The back-link field `reversedByPayslipId` IS
 * set on the original payslip by the reversal handler — that's a schema-
 * intended pointer, not a financial mutation.
 *
 * v2 schema notes:
 *   - All IDs are INT (number).
 *   - PayrollRun.status and Payslip.status are INT (PayrollRunStatus constants).
 *   - PayrollRun has no createdAt — use initiatedAt.
 *   - PayrollRun has no reversalOf relation — only reversalOfRunId INT.
 *   - Payslip.employee has relation objects for department/designation.
 *   - employee.role → employee.roleId (INT).
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
import { computePayslip, recomputeNet, finaliseEncashmentPayment } from './payrollEngine.js';
import { markEncashmentReversed } from '../leave/leave-encashment.service.js';
import {
  generateRunCode,
  generateReversalRunCode,
  generatePayslipCode,
} from './payrollCode.js';
import { acquireRunLock } from './concurrencyGuard.js';
import { streamPayslipPDF } from './payslip.pdf.js';
import { notify } from '../../lib/notifications.js';
import {
  RoleId,
  EmployeeStatus,
  PayrollRunStatus,
  type AuditActorRoleValue,
} from '../../lib/statusInt.js';

// ── Routers ───────────────────────────────────────────────────────────────────

export const payrollRouter = Router();
export const payslipsRouter = Router();
export const taxConfigRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map INT PayrollRunStatus to its display string (for PDF labels, etc.). */
function mapRunStatusToString(status: number): string {
  switch (status) {
    case PayrollRunStatus.Draft: return 'Draft';
    case PayrollRunStatus.Review: return 'Review';
    case PayrollRunStatus.Finalised: return 'Finalised';
    case PayrollRunStatus.Reversed: return 'Reversed';
    default: return 'Unknown';
  }
}

/** Format a PayrollRun row for the API response. */
function formatRun(
  run: {
    id: number;
    code: string;
    month: number;
    year: number;
    status: number;
    workingDays: number;
    periodStart: Date;
    periodEnd: Date;
    initiatedBy: number;
    initiatedAt: Date;
    initiator: { name: string };
    finalisedBy: number | null;
    finaliser?: { name: string } | null;
    finalisedAt: Date | null;
    reversedBy: number | null;
    reverser?: { name: string } | null;
    reversedAt: Date | null;
    reversalReason: string | null;
    reversalOfRunId: number | null;
    updatedAt?: Date;
    version: number;
    payslips?: Array<{
      grossPaise: number;
      lopDeductionPaise: number;
      finalTaxPaise: number;
      netPayPaise: number;
      lopDays: number;
      workingDays: number;
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
  const lopCount = slips.filter((s) => s.lopDays > 0).length;
  const proRatedCount = slips.filter((s) => s.workingDays < run.workingDays).length;

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
    initiatedAt: run.initiatedAt.toISOString(),
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
    lopCount,
    proRatedCount,
    updatedAt: run.updatedAt?.toISOString() ?? run.initiatedAt.toISOString(),
    version: run.version,
  };
}

/**
 * Format a Payslip row for the API response.
 *
 * `redactMoney` blanks out every paise field (basic / allowances / gross /
 * lop / tax / net / encashment). Used when a Manager looks at a
 * subordinate's payslip — per the production-hardening spec, managers can
 * see *status* but not *pay numbers*. Always false for Admin / PO and for
 * any caller viewing their own payslip.
 */
function formatPayslip(
  slip: {
    id: number;
    code: string;
    runId: number;
    run: { code: string };
    employeeId: number;
    employee: {
      name: string;
      code: string;
      designation: { name: string } | null;
      department: { name: string } | null;
    };
    month: number;
    year: number;
    status: number;
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
    encashmentDays?: number;
    encashmentPaise?: number;
    encashmentId?: number | null;
    finalisedAt: Date | null;
    reversalOfPayslipId: number | null;
    reversedByPayslipId: number | null;
    createdAt: Date;
    updatedAt: Date;
    version: number;
  },
  redactMoney = false,
) {
  return {
    id: slip.id,
    code: slip.code,
    runId: slip.runId,
    runCode: slip.run.code,
    employeeId: slip.employeeId,
    employeeName: slip.employee.name,
    employeeCode: slip.employee.code,
    designation: slip.employee.designation?.name ?? null,
    department: slip.employee.department?.name ?? null,
    month: slip.month,
    year: slip.year,
    status: slip.status,
    periodStart: slip.periodStart.toISOString().split('T')[0]!,
    periodEnd: slip.periodEnd.toISOString().split('T')[0]!,
    workingDays: slip.workingDays,
    daysWorked: slip.daysWorked,
    lopDays: slip.lopDays,
    basicPaise:           redactMoney ? null : slip.basicPaise,
    allowancesPaise:      redactMoney ? null : slip.allowancesPaise,
    grossPaise:           redactMoney ? null : slip.grossPaise,
    lopDeductionPaise:    redactMoney ? null : slip.lopDeductionPaise,
    referenceTaxPaise:    redactMoney ? null : slip.referenceTaxPaise,
    finalTaxPaise:        redactMoney ? null : slip.finalTaxPaise,
    otherDeductionsPaise: redactMoney ? null : slip.otherDeductionsPaise,
    netPayPaise:          redactMoney ? null : slip.netPayPaise,
    encashmentDays: slip.encashmentDays ?? 0,
    encashmentPaise: redactMoney ? null : (slip.encashmentPaise ?? 0),
    encashmentId: slip.encashmentId ?? null,
    finalisedAt: slip.finalisedAt?.toISOString() ?? null,
    reversalOfPayslipId: slip.reversalOfPayslipId,
    reversedByPayslipId: slip.reversedByPayslipId,
    createdAt: slip.createdAt.toISOString(),
    updatedAt: slip.updatedAt.toISOString(),
    version: slip.version,
  };
}

import type { Prisma } from '@prisma/client';

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
      lopDays: true,
      workingDays: true,
    },
  },
} as const satisfies Prisma.PayrollRunInclude;

const slipInclude = {
  run: { select: { code: true } },
  employee: {
    select: {
      name: true,
      code: true,
      designation: { select: { name: true } },
      department: { select: { name: true } },
    },
  },
} as const satisfies Prisma.PayslipInclude;

// ── POST /payroll/runs ────────────────────────────────────────────────────────

payrollRouter.post(
  '/runs',
  requireSession(),
  requireRole(RoleId.Admin, RoleId.PayrollOfficer),
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
        // Look for any source-run rows (not themselves reversal records,
        // not marked Reversed) for this (month, year). Any candidate that
        // has NOT been reversed still owns the slot and blocks re-create.
        //
        // BL-032: a reversed source run keeps status=Finalised forever —
        // the only "this slot is free again" signal is the existence of a
        // child PayrollRun pointing at it via reversalOfRunId. We do that
        // check explicitly here instead of relying on the source row's
        // own fields, otherwise the user gets locked out of the month for
        // life after the first reversal.
        const candidates = await tx.payrollRun.findMany({
          where: {
            month,
            year,
            reversalOfRunId: null,
            status: { not: PayrollRunStatus.Reversed },
          },
          select: { id: true, code: true, status: true },
        });

        if (candidates.length > 0) {
          const reversedSet = new Set(
            (
              await tx.payrollRun.findMany({
                where: { reversalOfRunId: { in: candidates.map((c) => c.id) } },
                select: { reversalOfRunId: true },
              })
            ).map((r) => r.reversalOfRunId!),
          );
          const blocking = candidates.find((c) => !reversedSet.has(c.id));

          if (blocking) {
            const e: TxErr = new Error(
              `A payroll run already exists for ${year}-${String(month).padStart(2, '0')} (code: ${blocking.code}, status: ${blocking.status}).`,
            );
            e.statusCode = 409;
            e.code = ErrorCode.RUN_ALREADY_EXISTS;
            throw e;
          }
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
            status: PayrollRunStatus.Review,
            workingDays,
            periodStart,
            periodEnd,
            initiatedBy: user.id,
            version: 0,
          },
        });

        // Fetch all Active or On-Notice employees
        const employees = await tx.employee.findMany({
          where: {
            status: {
              in: [EmployeeStatus.Active, EmployeeStatus.OnNotice],
            },
          },
        });

        let payslipCount = 0;
        const skipped: string[] = [];

        for (const emp of employees) {
          try {
            const values = await computePayslip(emp, run, referenceRate, tx);

            const newPayslip = await tx.payslip.create({
              data: {
                code: values.code,
                runId: run.id,
                employeeId: emp.id,
                month: values.month,
                year: values.year,
                status: PayrollRunStatus.Review,
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
                // BL-LE-09: encashment fields
                encashmentDays: values.encashmentDays,
                encashmentPaise: values.encashmentPaise,
                encashmentId: values.encashmentId ?? undefined,
                version: 0,
              },
            });

            // BL-LE-09: mark encashment Paid inside same transaction
            if (values.encashmentId) {
              await finaliseEncashmentPayment(values, newPayslip.id, tx);
            }

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
          actorRole: user.roleId as AuditActorRoleValue,
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
            status: PayrollRunStatus.Review,
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
      where: { roleId: RoleId.PayrollOfficer, status: EmployeeStatus.Active },
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
      where: { status: { in: [EmployeeStatus.Active, EmployeeStatus.OnNotice] } },
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
  requireRole(RoleId.Admin, RoleId.PayrollOfficer),
  validateQuery(PayrollRunListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const { year, status, cursor, limit } = req.query as {
      year?: string;
      status?: string;
      cursor?: string;
      limit?: string;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {};
    if (year) where['year'] = Number(year);
    if (status) where['status'] = Number(status);
    if (cursor) where['id'] = { gt: Number(cursor) };

    const runs = await prisma.payrollRun.findMany({
      where,
      orderBy: [{ year: 'desc' }, { month: 'desc' }, { initiatedAt: 'desc' }],
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
    const nextCursor = hasMore ? String(page[page.length - 1]?.id ?? '') : null;

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
      initiatedAt: r.initiatedAt.toISOString(),
    }));

    res.status(200).json({ data: formatted, nextCursor });
  },
);

// ── GET /payroll/runs/:id ─────────────────────────────────────────────────────

payrollRouter.get(
  '/runs/:id',
  requireSession(),
  requireRole(RoleId.Admin, RoleId.PayrollOfficer),
  async (req: Request, res: Response): Promise<void> => {
    const runId = Number(req.params['id']);
    if (isNaN(runId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payroll run not found.'));
      return;
    }

    const run = await prisma.payrollRun.findUnique({
      where: { id: runId },
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

    // Re-format run using payslip aggregates. Payslips themselves are
    // fetched via the paginated GET /payslips?runId=… endpoint.
    const runFormatted = formatRun({
      ...run,
      payslips: run.payslips.map((s) => ({
        grossPaise: s.grossPaise,
        lopDeductionPaise: s.lopDeductionPaise,
        finalTaxPaise: s.finalTaxPaise,
        netPayPaise: s.netPayPaise,
        lopDays: s.lopDays,
        workingDays: s.workingDays,
      })),
    });

    res.status(200).json({ data: { run: runFormatted } });
  },
);

// ── POST /payroll/runs/:id/finalise ───────────────────────────────────────────

payrollRouter.post(
  '/runs/:id/finalise',
  requireSession(),
  requireRole(RoleId.Admin, RoleId.PayrollOfficer),
  idempotencyKey(),
  validateBody(FinaliseRunRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const runId = Number(req.params['id']);
    if (isNaN(runId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payroll run not found.'));
      return;
    }
    const { version } = req.body as { confirm: 'FINALISE'; version: number };

    let finalisedRun;

    try {
      finalisedRun = await prisma.$transaction(async (tx) => {
        // BL-034: acquire row-level lock
        const locked = await acquireRunLock(runId, tx);

        if (!locked) {
          const e = new Error('Payroll run not found.') as Error & { statusCode: number; code: string };
          e.statusCode = 404;
          e.code = ErrorCode.NOT_FOUND;
          throw e;
        }

        // Re-check status post-lock
        if (locked.status === PayrollRunStatus.Finalised) {
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

        if (
          locked.status !== PayrollRunStatus.Review &&
          locked.status !== PayrollRunStatus.Draft
        ) {
          const e = new Error(`Run cannot be finalised from this status.`) as Error & {
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
          where: { id: runId },
          data: {
            status: PayrollRunStatus.Finalised,
            finalisedBy: user.id,
            finalisedAt: now,
            version: { increment: 1 },
          },
          include: runInclude,
        });

        // Update all payslips (BL-031: they become immutable after this)
        await tx.payslip.updateMany({
          where: { runId },
          data: {
            status: PayrollRunStatus.Finalised,
            finalisedAt: now,
          },
        });

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.roleId as AuditActorRoleValue,
          actorIp: req.ip ?? null,
          action: 'payroll.run.finalise',
          targetType: 'PayrollRun',
          targetId: runId,
          module: 'payroll',
          before: { status: locked.status, version: locked.version },
          after: { status: PayrollRunStatus.Finalised, finalisedAt: now.toISOString(), finalisedBy: user.id },
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
      where: { id: runId },
      include: runInclude,
    });

    // Notify all employees whose payslip was in this run that it's ready
    const finalizedPayslips = await prisma.payslip.findMany({
      where: { runId, status: PayrollRunStatus.Finalised, reversalOfPayslipId: null },
      select: { id: true, employeeId: true, month: true, year: true },
    });

    if (finalizedPayslips.length > 0) {
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
  requireRole(RoleId.Admin),  // BL-033: only Admin can reverse
  idempotencyKey(),
  validateBody(ReverseRunRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const sourceId = Number(req.params['id']);
    if (isNaN(sourceId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payroll run not found.'));
      return;
    }
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

        if (locked.status !== PayrollRunStatus.Finalised) {
          const e = new Error(
            `Only Finalised runs can be reversed.`,
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
            status: PayrollRunStatus.Reversed,
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
              status: PayrollRunStatus.Reversed,
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
              // BL-LE-11: negative encashment line on reversal payslip
              encashmentDays: slip.encashmentDays,
              encashmentPaise: -(slip.encashmentPaise),  // negative = money returned
              version: 0,
            },
          });

          // Point the source payslip to its reversal record (BL-032)
          await tx.payslip.update({
            where: { id: slip.id },
            data: { reversedByPayslipId: revSlip.id },
          });

          // BL-LE-11: if this payslip had an encashment, write the reverse audit row
          if (slip.encashmentId) {
            await markEncashmentReversed(slip.encashmentId, revSlip.id, tx);
          }

          payslipCount++;
        }

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.roleId as AuditActorRoleValue,
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
      prisma.employee.findMany({
        where: { roleId: RoleId.Admin, status: EmployeeStatus.Active },
        select: { id: true },
      }),
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
  requireRole(RoleId.Admin, RoleId.PayrollOfficer),
  validateQuery(PaginationQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    const take = (Number(limit) || 20) + 1;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = { reversalOfRunId: { not: null } };
    if (cursor) where['id'] = { gt: Number(cursor) };

    const reversals = await prisma.payrollRun.findMany({
      where,
      orderBy: { reversedAt: 'desc' },
      take,
      include: {
        reverser: { select: { name: true } },
        payslips: { select: { netPayPaise: true } },
      },
    });

    const hasMore = reversals.length > (Number(limit) || 20);
    const page = hasMore ? reversals.slice(0, Number(limit) || 20) : reversals;
    const nextCursor = hasMore ? String(page[page.length - 1]?.id ?? '') : null;

    // We need originalRunCode — fetch source run codes
    const sourceRunIds = page
      .map((r) => r.reversalOfRunId)
      .filter((id): id is number => id !== null);

    const sourceRuns = sourceRunIds.length > 0
      ? await prisma.payrollRun.findMany({
          where: { id: { in: sourceRunIds } },
          select: { id: true, code: true },
        })
      : [];
    const sourceRunMap = new Map(sourceRuns.map((r) => [r.id, r.code]));

    const formatted = page.map((r) => ({
      reversalRunId: r.id,
      reversalRunCode: r.code,
      originalRunId: r.reversalOfRunId!,
      originalRunCode: r.reversalOfRunId !== null ? (sourceRunMap.get(r.reversalOfRunId) ?? '') : '',
      month: r.month,
      year: r.year,
      reversedBy: r.reversedBy ?? null,
      reversedByName: r.reverser?.name ?? '',
      reversedAt: r.reversedAt?.toISOString() ?? r.initiatedAt.toISOString(),
      reason: r.reversalReason ?? '',
      affectedEmployees: r.payslips.length,
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
        year?: string;
        month?: string;
        employeeId?: string;
        status?: string;
        runId?: string;
        isReversal?: string;
        cursor?: string;
        limit?: string;
      };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {};

    // Scope by role
    if (user.roleId === RoleId.Employee) {
      where['employeeId'] = user.id;
    } else if (user.roleId === RoleId.Manager) {
      const subs = await getSubordinateIds(user.id);
      const allowed: number[] = [user.id, ...subs];
      if (employeeId) {
        const empId = Number(employeeId);
        if (!allowed.includes(empId)) {
          res.status(200).json({ data: [], nextCursor: null, total: 0 });
          return;
        }
        where['employeeId'] = empId;
      } else {
        where['employeeId'] = { in: allowed };
      }
    } else {
      // Admin / PayrollOfficer — see all
      if (employeeId) where['employeeId'] = Number(employeeId);
    }

    if (year) where['year'] = Number(year);
    if (month) where['month'] = Number(month);
    if (status) where['status'] = Number(status);
    if (runId) where['runId'] = Number(runId);
    if (isReversal !== undefined) {
      where['reversalOfPayslipId'] = isReversal === 'true' ? { not: null } : null;
    }

    // Two ordering strategies:
    //   1. Run-scoped list (runId filter set): every employee has one payslip,
    //      so we sort alphabetically by employee name. The cursor is still
    //      the last-seen payslip id; we look up that row's employee name and
    //      use it as a `name > X` filter so cursor pagination stays correct
    //      under name-asc ordering. Same pattern as employees list.
    //   2. Otherwise (My Payslips list across runs): keep the existing
    //      year/month/createdAt DESC order with the id-cursor.
    const isRunScoped = Boolean(runId);

    // Snapshot the filter WHERE before adding the cursor clause so the
    // total count reflects the full filter (not the current page slice).
    const totalWhere = { ...where };

    if (cursor) {
      if (isRunScoped) {
        const cursorSlip = await prisma.payslip.findUnique({
          where: { id: Number(cursor) },
          select: { employee: { select: { name: true } } },
        });
        if (cursorSlip) {
          where['employee'] = { name: { gt: cursorSlip.employee.name } };
        }
      } else {
        where['id'] = { gt: Number(cursor) };
      }
    }

    const [slips, total] = await Promise.all([
      prisma.payslip.findMany({
        where,
        orderBy: isRunScoped
          ? { employee: { name: 'asc' } }
          : [{ year: 'desc' }, { month: 'desc' }, { createdAt: 'desc' }],
        take: (Number(limit) || 20) + 1,
        include: slipInclude,
      }),
      prisma.payslip.count({ where: totalWhere }),
    ]);

    const hasMore = slips.length > (Number(limit) || 20);
    const page = hasMore ? slips.slice(0, Number(limit) || 20) : slips;
    const nextCursor = hasMore ? String(page[page.length - 1]?.id ?? '') : null;

    const summaries = page.map((s) => {
      const redact = !canSeePayslipMoney(user.id, user.roleId, s.employeeId);
      return {
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
        grossPaise:    redact ? null : s.grossPaise,
        finalTaxPaise: redact ? null : s.finalTaxPaise,
        referenceTaxPaise: redact ? null : s.referenceTaxPaise,
        netPayPaise:   redact ? null : s.netPayPaise,
        finalisedAt: s.finalisedAt?.toISOString() ?? null,
        reversalOfPayslipId: s.reversalOfPayslipId,
        version: s.version,
      };
    });

    res.status(200).json({ data: summaries, nextCursor, total });
  },
);

// ── GET /payslips/:id ─────────────────────────────────────────────────────────

payslipsRouter.get(
  '/:id',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const slipId = Number(req.params['id']);
    if (isNaN(slipId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }

    const slip = await prisma.payslip.findUnique({
      where: { id: slipId },
      include: slipInclude,
    });

    if (!slip) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }

    // Visibility check
    const canSee = await canViewPayslip(user.id, user.roleId, slip.employeeId);
    if (!canSee) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }

    const redact = !canSeePayslipMoney(user.id, user.roleId, slip.employeeId);
    res.status(200).json({ data: formatPayslip(slip, redact) });
  },
);

// ── PATCH /payslips/:id/tax ───────────────────────────────────────────────────

payslipsRouter.patch(
  '/:id/tax',
  requireSession(),
  requireRole(RoleId.Admin, RoleId.PayrollOfficer),
  idempotencyKey(),
  validateBody(UpdatePayslipTaxRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const slipId = Number(req.params['id']);
    if (isNaN(slipId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }
    const { finalTaxPaise: newTax, version } = req.body as {
      finalTaxPaise: number;
      version: number;
    };

    const slip = await prisma.payslip.findUnique({
      where: { id: slipId },
      include: { run: { select: { status: true } } },
    });

    if (!slip) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }

    // BL-031: reject if payslip is Finalised or Reversed
    if (
      slip.status === PayrollRunStatus.Finalised ||
      slip.status === PayrollRunStatus.Reversed
    ) {
      res.status(409).json(
        errorEnvelope(ErrorCode.PAYSLIP_IMMUTABLE, 'This payslip is finalised and cannot be modified.', {
          ruleId: 'BL-031',
        }),
      );
      return;
    }

    // Run must be in a mutable state (Draft or Review)
    if (
      slip.run.status === PayrollRunStatus.Finalised ||
      slip.run.status === PayrollRunStatus.Reversed
    ) {
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
        where: { id: slipId },
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
        actorRole: user.roleId as AuditActorRoleValue,
        actorIp: req.ip ?? null,
        action: 'payslip.tax.update',
        targetType: 'Payslip',
        targetId: slipId,
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
    const slipId = Number(req.params['id']);
    if (isNaN(slipId)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }

    const slip = await prisma.payslip.findUnique({
      where: { id: slipId },
      include: slipInclude,
    });

    if (!slip) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }

    const canSee = await canViewPayslip(user.id, user.roleId, slip.employeeId);
    if (!canSee) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Payslip not found.'));
      return;
    }

    // Hardening: PDFs always include money figures. Managers can see a
    // subordinate's *status* in the JSON detail but must not be able to
    // download the PDF (which would leak gross / net / tax).
    if (!canSeePayslipMoney(user.id, user.roleId, slip.employeeId)) {
      res
        .status(403)
        .json(errorEnvelope(ErrorCode.FORBIDDEN, 'Payslip PDF is not available for this role.'));
      return;
    }

    streamPayslipPDF(
      {
        code: slip.code,
        month: slip.month,
        year: slip.year,
        status: mapRunStatusToString(slip.status),
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
        reversalOfPayslipId: slip.reversalOfPayslipId !== null ? String(slip.reversalOfPayslipId) : null,
        employeeName: slip.employee.name,
        employeeCode: slip.employee.code,
        designation: slip.employee.designation?.name ?? null,
        department: slip.employee.department?.name ?? null,
        runCode: slip.run.code,
      },
      res,
    );
  },
);

// ── Tax config ────────────────────────────────────────────────────────────────

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
  requireRole(RoleId.Admin),
  async (_req: Request, res: Response): Promise<void> => {
    const [rateRow, basisRow] = await Promise.all([
      prisma.configuration.findUnique({
        where: { key: 'STANDARD_TAX_REFERENCE_RATE' },
      }),
      prisma.configuration.findUnique({
        where: { key: 'TAX_GROSS_TAXABLE_BASIS' },
      }),
    ]);

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

// PATCH /config/tax
taxConfigRouter.patch(
  '/',
  requireSession(),
  requireRole(RoleId.Admin),
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
            updatedBy: String(user.id),
          },
          update: {
            value: referenceRate,
            updatedBy: String(user.id),
          },
        });

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.roleId as AuditActorRoleValue,
          actorIp: req.ip ?? null,
          action: 'config.tax.update',
          targetType: 'Configuration',
          targetId: null,
          module: 'payroll',
          before: { key: 'STANDARD_TAX_REFERENCE_RATE', referenceRate: (beforeRate?.value as number) ?? null },
          after: { key: 'STANDARD_TAX_REFERENCE_RATE', referenceRate },
        });
      }

      if (grossTaxableBasis !== undefined) {
        nextBasisRow = await tx.configuration.upsert({
          where: { key: 'TAX_GROSS_TAXABLE_BASIS' },
          create: {
            key: 'TAX_GROSS_TAXABLE_BASIS',
            value: grossTaxableBasis,
            updatedBy: String(user.id),
          },
          update: {
            value: grossTaxableBasis,
            updatedBy: String(user.id),
          },
        });

        await audit({
          tx,
          actorId: user.id,
          actorRole: user.roleId as AuditActorRoleValue,
          actorIp: req.ip ?? null,
          action: 'config.tax.update',
          targetType: 'Configuration',
          targetId: null,
          module: 'payroll',
          before: { key: 'TAX_GROSS_TAXABLE_BASIS', grossTaxableBasis: coerceBasis(beforeBasis?.value) },
          after: { key: 'TAX_GROSS_TAXABLE_BASIS', grossTaxableBasis },
        });
      }

      return { rateRow: nextRateRow, basisRow: nextBasisRow };
    });

    if (referenceRate !== undefined) {
      const payrollOfficers = await prisma.employee.findMany({
        where: { roleId: RoleId.PayrollOfficer, status: EmployeeStatus.Active },
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
 */
async function canViewPayslip(
  userId: number,
  userRoleId: number,
  ownerId: number,
): Promise<boolean> {
  if (userRoleId === RoleId.Admin || userRoleId === RoleId.PayrollOfficer) return true;
  if (userId === ownerId) return true;

  if (userRoleId === RoleId.Manager) {
    const subs = await getSubordinateIds(userId);
    return subs.includes(ownerId);
  }

  return false;
}

/**
 * Returns true if the calling user is allowed to see the *money fields*
 * on a payslip (gross/net/tax/etc.). Per the production-hardening spec:
 *
 *   Admin             → yes (org-wide visibility)
 *   PayrollOfficer    → yes (payroll responsibility)
 *   Employee viewing own → yes
 *   Manager viewing subordinate → NO (sees status but not amounts)
 *
 * A manager viewing their own payslip falls through to the self-view
 * branch. Used by GET /payslips and GET /payslips/:id to decide whether
 * to redact the money fields; the PDF endpoint blocks managers outright
 * since a PDF can't cleanly omit the figures.
 */
function canSeePayslipMoney(
  userId: number,
  userRoleId: number,
  ownerId: number,
): boolean {
  if (userRoleId === RoleId.Admin || userRoleId === RoleId.PayrollOfficer) return true;
  if (userId === ownerId) return true;
  return false;
}
