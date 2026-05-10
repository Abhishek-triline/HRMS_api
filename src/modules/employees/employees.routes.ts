/**
 * Employees & Hierarchy router — mounted at /api/v1/employees.
 *
 * Endpoints (docs/HRMS_API.md § 5):
 *   POST   /                      A-04 / D-02   Admin only
 *   GET    /                      A-03 / M-02   Admin / Manager (scoped to team)
 *   GET    /:id                   A-04, M-02    Admin / Manager-team / SELF
 *   PATCH  /:id                   D-02          Admin only (optimistic concurrency)
 *   PATCH  /:id/salary            D-04          Admin only — inserts new salary row (BL-030)
 *   POST   /:id/status            D-02          Admin only — Active / On-Notice / Exited (BL-006)
 *   POST   /:id/reassign-manager  D-14          Admin only — circular check (BL-005)
 *   GET    /:id/team              M-02          Manager-own / Admin
 *   GET    /:id/profile           profile       SELF / Admin (read-only)
 *
 * Business rules enforced:
 *   BL-005  Circular reporting chain detection
 *   BL-006  Status transition guard (On-Leave is system-set; refused here)
 *   BL-007  Historical records never deleted (reporting_manager_history)
 *   BL-008  EMP code via generateEmpCode() — never reused
 *   BL-022  Pending approvals routing (close history row on exit / reassign)
 *   BL-022a Past team members surfaced in /team endpoint
 *   BL-030  Salary edits insert new SalaryStructure row; old payslips unaffected
 *   BL-034  Optimistic concurrency on PATCH /:id (version check)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  CreateEmployeeRequestSchema,
  EmployeeListQuerySchema,
  UpdateEmployeeRequestSchema,
  UpdateSalaryRequestSchema,
  ChangeStatusRequestSchema,
  ReassignManagerRequestSchema,
} from '@nexora/contracts/employees';
import type {
  EmployeeDetail,
  EmployeeListItem,
  TeamMember,
} from '@nexora/contracts/employees';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import { requireSession } from '../../middleware/requireSession.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validateBody.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { audit } from '../../lib/audit.js';
import { sendMail } from '../../lib/mailer.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { generateEmpCode } from './empCode.js';
import {
  getSubordinateIds,
  wouldCreateCycle,
  getPastTeamMembers,
} from './hierarchy.js';
import { handleManagerChange } from '../performance/performance.service.js';
import { notify } from '../../lib/notifications.js';

const router = Router();

const WEB_BASE_URL = process.env['WEB_BASE_URL'] ?? 'http://localhost:3000';
const FIRST_LOGIN_TTL_DAYS = Number(process.env['FIRST_LOGIN_TTL_DAYS'] ?? 7);

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Map Prisma EmployeeStatus enum (no hyphens) → contract enum (with hyphens).
 */
function mapStatus(s: string): EmployeeDetail['status'] {
  const m: Record<string, EmployeeDetail['status']> = {
    Active: 'Active',
    OnNotice: 'On-Notice',
    Exited: 'Exited',
    OnLeave: 'On-Leave',
    Inactive: 'Inactive',
  };
  return m[s] ?? 'Inactive';
}

/**
 * Map contract EmployeeStatus (with hyphens) → Prisma enum (no hyphens).
 */
function mapStatusToDB(s: string): string {
  const m: Record<string, string> = {
    'Active': 'Active',
    'On-Notice': 'OnNotice',
    'Exited': 'Exited',
    'On-Leave': 'OnLeave',
    'Inactive': 'Inactive',
  };
  return m[s] ?? s;
}

type EmployeeWithSalary = {
  id: string;
  code: string;
  name: string;
  email: string;
  role: string;
  status: string;
  employmentType: string;
  department: string | null;
  designation: string | null;
  reportingManagerId: string | null;
  previousReportingManagerId: string | null;
  joinDate: Date;
  exitDate: Date | null;
  mustResetPassword: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  reportingManager?: { name: string; code: string } | null;
  salaryStructures?: Array<{
    basicPaise: number;
    allowancesPaise: number;
    effectiveFrom: Date;
  }>;
};

/**
 * Shape a DB employee row into the EmployeeDetail contract response shape.
 * includeSalary=false means the salaryStructure field is null (Manager view).
 */
function toEmployeeDetail(
  emp: EmployeeWithSalary,
  includeSalary: boolean,
): EmployeeDetail {
  const activeSalary =
    includeSalary && emp.salaryStructures && emp.salaryStructures.length > 0
      ? emp.salaryStructures[0]!
      : null;

  return {
    id: emp.id,
    code: emp.code,
    name: emp.name,
    email: emp.email,
    role: emp.role as EmployeeDetail['role'],
    status: mapStatus(emp.status),
    employmentType: emp.employmentType as EmployeeDetail['employmentType'],
    department: emp.department,
    designation: emp.designation,
    reportingManagerId: emp.reportingManagerId,
    reportingManagerName: emp.reportingManager?.name ?? null,
    reportingManagerCode: emp.reportingManager?.code ?? null,
    joinDate: emp.joinDate.toISOString().split('T')[0]!,
    exitDate: emp.exitDate ? emp.exitDate.toISOString().split('T')[0]! : null,
    salaryStructure: activeSalary
      ? {
          basic_paise: activeSalary.basicPaise,
          allowances_paise: activeSalary.allowancesPaise,
          effectiveFrom: activeSalary.effectiveFrom.toISOString().split('T')[0]!,
        }
      : null,
    mustResetPassword: emp.mustResetPassword,
    createdAt: emp.createdAt.toISOString(),
    updatedAt: emp.updatedAt.toISOString(),
    version: emp.version,
  };
}

/**
 * Fetch a full employee row for detail responses (includes manager name + active salary).
 */
async function fetchEmployeeDetail(id: string) {
  return prisma.employee.findUnique({
    where: { id },
    include: {
      reportingManager: { select: { name: true, code: true } },
      salaryStructures: {
        orderBy: { effectiveFrom: 'desc' },
        take: 1,
      },
    },
  });
}

/** Client IP from request. */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

// ── POST / ───────────────────────────────────────────────────────────────────
// Create employee (Admin only). Generates EMP code, sends first-login email.

router.post(
  '/',
  requireSession(),
  requireRole('Admin'),
  validateBody(CreateEmployeeRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as {
      name: string;
      email: string;
      role: string;
      department: string;
      designation: string;
      employmentType: string;
      reportingManagerId: string | null;
      joinDate: string;
      salaryStructure: { basic_paise: number; allowances_paise: number; effectiveFrom: string };
    };
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      // Validate reportingManagerId exists if provided
      if (body.reportingManagerId) {
        const mgr = await prisma.employee.findUnique({
          where: { id: body.reportingManagerId },
        });
        if (!mgr) {
          res.status(400).json(
            errorEnvelope(ErrorCode.VALIDATION_FAILED, 'reportingManagerId does not exist.', {
              details: { reportingManagerId: ['Employee not found.'] },
            }),
          );
          return;
        }
      }

      // Check email uniqueness before starting the transaction
      const emailExists = await prisma.employee.findUnique({
        where: { email: body.email.toLowerCase() },
      });
      if (emailExists) {
        res.status(400).json(
          errorEnvelope(ErrorCode.VALIDATION_FAILED, 'Email already registered.', {
            details: { email: ['Must be unique.'] },
          }),
        );
        return;
      }

      const joinDate = new Date(body.joinDate);
      const now = new Date();
      const year = now.getFullYear();
      const expiresAt = new Date(now.getTime() + FIRST_LOGIN_TTL_DAYS * 24 * 60 * 60 * 1000);

      // Generate a first-login token (raw — only hash is stored)
      const { generateToken, hashToken } = await import('../auth/auth.service.js');
      const rawToken = generateToken();
      const tokenHash = hashToken(rawToken);

      const employee = await prisma.$transaction(async (tx) => {
        // Generate EMP code inside the transaction with FOR UPDATE lock
        const code = await generateEmpCode(year, tx);

        // Create the employee record
        const newEmp = await tx.employee.create({
          data: {
            code,
            email: body.email.toLowerCase(),
            name: body.name,
            passwordHash: '', // placeholder — set on first login
            role: body.role as never,
            status: 'Inactive',
            employmentType: body.employmentType as never,
            department: body.department,
            designation: body.designation,
            reportingManagerId: body.reportingManagerId ?? null,
            joinDate,
            mustResetPassword: true,
            version: 0,
          },
        });

        // Create the initial salary structure row (BL-030)
        await tx.salaryStructure.create({
          data: {
            employeeId: newEmp.id,
            basicPaise: body.salaryStructure.basic_paise,
            allowancesPaise: body.salaryStructure.allowances_paise,
            effectiveFrom: new Date(body.salaryStructure.effectiveFrom),
            version: 0,
          },
        });

        // Create the initial ReportingManagerHistory row (reason = Initial)
        await tx.reportingManagerHistory.create({
          data: {
            employeeId: newEmp.id,
            managerId: body.reportingManagerId ?? null,
            fromDate: joinDate,
            toDate: null,
            reason: 'Initial',
          },
        });

        // Create first-login token
        await tx.passwordResetToken.create({
          data: {
            employeeId: newEmp.id,
            tokenHash,
            purpose: 'FirstLogin',
            expiresAt,
          },
        });

        // Audit employee creation
        await audit({
          tx,
          actorId: actor.id,
          actorRole: actor.role,
          actorIp: ip,
          action: 'employee.create',
          targetType: 'Employee',
          targetId: newEmp.id,
          module: 'employees',
          before: null,
          after: {
            code: newEmp.code,
            email: newEmp.email,
            name: newEmp.name,
            role: newEmp.role,
            status: newEmp.status,
            employmentType: newEmp.employmentType,
            department: newEmp.department,
            designation: newEmp.designation,
            reportingManagerId: newEmp.reportingManagerId,
            joinDate: body.joinDate,
          },
        });

        return newEmp;
      });

      // Send invitation email (fire-and-forget — sendMail never throws)
      const inviteUrl = `${WEB_BASE_URL}/first-login?token=${rawToken}`;
      // SEC-002-P1: HTML-escape any user-controlled value before interpolating
      // it into the email body. The text variant escapes nothing (it's plain
      // text) but we keep the same name source — the schema also strips
      // control characters at the input layer.
      const escapeHtml = (s: string): string =>
        s.replace(/[&<>"']/g, (c) => {
          const map: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          };
          return map[c] ?? c;
        });
      const safeName = escapeHtml(employee.name);
      const safeCode = escapeHtml(employee.code);
      const safeUrl = escapeHtml(inviteUrl);
      await sendMail({
        to: employee.email,
        subject: 'Welcome to Nexora HRMS — Activate your account',
        text: [
          `Hello ${employee.name},`,
          '',
          `Your Nexora HRMS account has been created (employee code: ${employee.code}).`,
          '',
          `Click the link below to set your password and activate your account (valid for ${FIRST_LOGIN_TTL_DAYS} days):`,
          '',
          inviteUrl,
          '',
          'If you did not expect this email, please contact your HR administrator.',
          '',
          'Nexora HRMS',
        ].join('\n'),
        html: [
          `<p>Hello ${safeName},</p>`,
          `<p>Your Nexora HRMS account has been created (employee code: <strong>${safeCode}</strong>).</p>`,
          `<p>Click the link below to set your password and activate your account (valid for ${FIRST_LOGIN_TTL_DAYS} days):</p>`,
          `<p><a href="${safeUrl}">${safeUrl}</a></p>`,
          `<p>If you did not expect this email, please contact your HR administrator.</p>`,
        ].join(''),
      });

      // Fetch the full detail (with salary + manager name) for the response
      const detail = await fetchEmployeeDetail(employee.id);
      if (!detail) {
        res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Employee created but could not be fetched.'));
        return;
      }

      res.status(201).json({
        data: {
          employee: toEmployeeDetail(detail, true),
          invitationSent: true,
        },
      });
    } catch (err: unknown) {
      logger.error({ err }, 'employees.create.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to create employee.'));
    }
  },
);

// ── GET / ─────────────────────────────────────────────────────────────────────
// List employees (Admin: all; Manager: scoped to subordinates). Cursor-paginated.

router.get(
  '/',
  requireSession(),
  requireRole('Admin', 'Manager'),
  validateQuery(EmployeeListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as {
      cursor?: string;
      limit?: number;
      status?: string;
      role?: string;
      department?: string;
      employmentType?: string;
      managerId?: string;
      q?: string;
      sort?: string;
    };
    const actor = req.user!;

    try {
      const limit = Number(query.limit ?? 20);

      // Manager scope: only their direct + indirect reports
      let allowedIds: string[] | null = null;
      if (actor.role === 'Manager') {
        allowedIds = await getSubordinateIds(actor.id);

        // If a managerId filter is provided, it must match self (BL-022 — no cross-team data leak)
        if (query.managerId && query.managerId !== actor.id) {
          res.status(403).json(
            errorEnvelope(
              ErrorCode.FORBIDDEN,
              'Managers may only filter by their own team.',
            ),
          );
          return;
        }
      }

      // Build Prisma where clause
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: Record<string, any> = {};

      if (allowedIds !== null) {
        where['id'] = { in: allowedIds };
      }

      if (query.status) {
        where['status'] = mapStatusToDB(query.status);
      }

      if (query.role) {
        where['role'] = query.role;
      }

      if (query.department) {
        where['department'] = query.department;
      }

      if (query.employmentType) {
        where['employmentType'] = query.employmentType;
      }

      if (query.managerId && actor.role === 'Admin') {
        where['reportingManagerId'] = query.managerId;
      }

      if (query.q) {
        const q = `%${query.q}%`;
        where['OR'] = [
          { name: { contains: query.q } },
          { email: { contains: query.q } },
          { code: { contains: query.q } },
          { department: { contains: query.q } },
          { designation: { contains: query.q } },
        ];
        void q; // used in raw query alternative; Prisma `contains` handles it
      }

      // Cursor pagination: cursor is the employee id of the last item seen.
      // SEC-003-P1: scope the cursor lookup to the same `allowedIds` so a
      // Manager can't probe arbitrary employee IDs to oracle their existence.
      // Out-of-scope cursors silently fall back to "no cursor" (page 1).
      if (query.cursor) {
        const cursorEmp = await prisma.employee.findFirst({
          where: {
            id: query.cursor,
            ...(allowedIds !== null ? { id: { in: allowedIds } } : {}),
          },
          select: { name: true },
        });
        if (cursorEmp) {
          // Cursor: items after this name (for name ASC sort)
          where['name'] = { gt: cursorEmp.name };
        }
      }

      // Sort: default name ASC; accept "-name" for DESC
      const sortField = query.sort ?? 'name';
      const sortDir = sortField.startsWith('-') ? 'desc' : 'asc';
      const sortKey = sortField.replace(/^-/, '');
      const allowedSortKeys = ['name', 'email', 'code', 'joinDate', 'status', 'department'];
      const finalSortKey = allowedSortKeys.includes(sortKey) ? sortKey : 'name';

      const employees = await prisma.employee.findMany({
        where,
        include: {
          reportingManager: { select: { name: true, code: true } },
        },
        orderBy: { [finalSortKey]: sortDir },
        take: limit + 1, // +1 to detect if there's a next page
      });

      const hasNextPage = employees.length > limit;
      const items = hasNextPage ? employees.slice(0, limit) : employees;
      const nextCursor = hasNextPage ? items[items.length - 1]!.id : null;

      const data: EmployeeListItem[] = items.map((emp) => ({
        id: emp.id,
        code: emp.code,
        name: emp.name,
        email: emp.email,
        role: emp.role as EmployeeListItem['role'],
        status: mapStatus(emp.status),
        employmentType: emp.employmentType as EmployeeListItem['employmentType'],
        department: emp.department,
        designation: emp.designation,
        reportingManagerName: emp.reportingManager?.name ?? null,
        joinDate: emp.joinDate.toISOString().split('T')[0]!,
      }));

      res.status(200).json({ data, nextCursor });
    } catch (err: unknown) {
      logger.error({ err }, 'employees.list.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to list employees.'));
    }
  },
);

// ── GET /:id ──────────────────────────────────────────────────────────────────
// Get employee detail. Salary included for Admin / SELF; null for Manager view.

router.get(
  '/:id',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const actor = req.user!;

    try {
      const emp = await fetchEmployeeDetail(id);

      if (!emp) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      // RBAC: Admin sees all; SELF sees own; Manager sees only their tree
      const isSelf = actor.id === id;
      const isAdmin = actor.role === 'Admin';

      let canView = false;
      let includeSalary = false;

      if (isAdmin) {
        canView = true;
        includeSalary = true;
      } else if (isSelf) {
        canView = true;
        includeSalary = true;
      } else if (actor.role === 'Manager') {
        const subordinates = await getSubordinateIds(actor.id);
        if (subordinates.includes(id)) {
          canView = true;
          includeSalary = false; // Manager view: no salary (spec requirement)
        }
      }

      if (!canView) {
        // Return 404 to not leak existence (per § 1 RBAC note)
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      res.status(200).json({ data: toEmployeeDetail(emp, includeSalary) });
    } catch (err: unknown) {
      logger.error({ err }, 'employees.getById.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to fetch employee.'));
    }
  },
);

// ── PATCH /:id ────────────────────────────────────────────────────────────────
// Update employee profile (Admin only). Optimistic concurrency via version.

router.patch(
  '/:id',
  requireSession(),
  requireRole('Admin'),
  validateBody(UpdateEmployeeRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      name?: string;
      role?: string;
      department?: string;
      designation?: string;
      employmentType?: string;
      joinDate?: string;
      version: number;
    };
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      const current = await fetchEmployeeDetail(id);

      if (!current) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      // Optimistic concurrency check (BL-034)
      if (current.version !== body.version) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VERSION_MISMATCH, 'Record has been modified by another user. Reload and retry.', {
            details: { expectedVersion: body.version, actualVersion: current.version },
          }),
        );
        return;
      }

      const beforeSnapshot = {
        name: current.name,
        role: current.role,
        department: current.department,
        designation: current.designation,
        employmentType: current.employmentType,
        joinDate: current.joinDate.toISOString().split('T')[0],
        version: current.version,
      };

      const updateData: Record<string, unknown> = {
        version: { increment: 1 },
      };
      if (body.name !== undefined) updateData['name'] = body.name;
      if (body.role !== undefined) updateData['role'] = body.role;
      if (body.department !== undefined) updateData['department'] = body.department;
      if (body.designation !== undefined) updateData['designation'] = body.designation;
      if (body.employmentType !== undefined) updateData['employmentType'] = body.employmentType;
      if (body.joinDate !== undefined) updateData['joinDate'] = new Date(body.joinDate);

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.employee.update({
          where: { id },
          data: updateData as never,
          include: {
            reportingManager: { select: { name: true, code: true } },
            salaryStructures: { orderBy: { effectiveFrom: 'desc' }, take: 1 },
          },
        });

        await audit({
          tx,
          actorId: actor.id,
          actorRole: actor.role,
          actorIp: ip,
          action: 'employee.update',
          targetType: 'Employee',
          targetId: id,
          module: 'employees',
          before: beforeSnapshot,
          after: {
            name: u.name,
            role: u.role,
            department: u.department,
            designation: u.designation,
            employmentType: u.employmentType,
            joinDate: u.joinDate.toISOString().split('T')[0],
            version: u.version,
          },
        });

        return u;
      });

      res.status(200).json({ data: toEmployeeDetail(updated, true) });
    } catch (err: unknown) {
      logger.error({ err }, 'employees.update.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to update employee.'));
    }
  },
);

// ── PATCH /:id/salary ─────────────────────────────────────────────────────────
// Update salary (Admin only). Inserts a NEW SalaryStructure row (BL-030).

router.patch(
  '/:id/salary',
  requireSession(),
  requireRole('Admin'),
  validateBody(UpdateSalaryRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      basic_paise: number;
      allowances_paise: number;
      effectiveFrom: string;
      version: number;
    };
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      const current = await fetchEmployeeDetail(id);

      if (!current) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      // Version check against the employee record
      if (current.version !== body.version) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VERSION_MISMATCH, 'Record has been modified by another user. Reload and retry.', {
            details: { expectedVersion: body.version, actualVersion: current.version },
          }),
        );
        return;
      }

      const currentSalary = current.salaryStructures?.[0] ?? null;

      const updated = await prisma.$transaction(async (tx) => {
        // Insert a new salary row — NEVER mutate existing (BL-030 / BL-031)
        await tx.salaryStructure.create({
          data: {
            employeeId: id,
            basicPaise: body.basic_paise,
            allowancesPaise: body.allowances_paise,
            effectiveFrom: new Date(body.effectiveFrom),
            version: 0,
          },
        });

        // Bump employee version so concurrent callers see a stale token
        const u = await tx.employee.update({
          where: { id },
          data: { version: { increment: 1 } },
          include: {
            reportingManager: { select: { name: true, code: true } },
            salaryStructures: { orderBy: { effectiveFrom: 'desc' }, take: 1 },
          },
        });

        await audit({
          tx,
          actorId: actor.id,
          actorRole: actor.role,
          actorIp: ip,
          action: 'employee.salary.update',
          targetType: 'Employee',
          targetId: id,
          module: 'employees',
          before: currentSalary
            ? {
                basic_paise: currentSalary.basicPaise,
                allowances_paise: currentSalary.allowancesPaise,
                effectiveFrom: currentSalary.effectiveFrom.toISOString().split('T')[0],
              }
            : null,
          after: {
            basic_paise: body.basic_paise,
            allowances_paise: body.allowances_paise,
            effectiveFrom: body.effectiveFrom,
          },
        });

        return u;
      });

      res.status(200).json({ data: toEmployeeDetail(updated, true) });
    } catch (err: unknown) {
      logger.error({ err }, 'employees.salary.update.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to update salary.'));
    }
  },
);

// ── POST /:id/status ──────────────────────────────────────────────────────────
// Change employee status (Admin only). On-Leave is refused (BL-006).

router.post(
  '/:id/status',
  requireSession(),
  requireRole('Admin'),
  validateBody(ChangeStatusRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      status: 'Active' | 'On-Notice' | 'Exited';
      effectiveDate: string;
      exitDate?: string;
      note?: string;
      version: number;
    };
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      const current = await fetchEmployeeDetail(id);

      if (!current) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      // Optimistic concurrency check
      if (current.version !== body.version) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VERSION_MISMATCH, 'Record has been modified by another user. Reload and retry.', {
            details: { expectedVersion: body.version, actualVersion: current.version },
          }),
        );
        return;
      }

      // BL-006: On-Leave is system-set only — refuse it explicitly
      if ((body.status as string) === 'On-Leave') {
        res.status(400).json(
          errorEnvelope(
            ErrorCode.VALIDATION_FAILED,
            'The On-Leave status is system-controlled and cannot be set manually (BL-006).',
            { ruleId: 'BL-006' },
          ),
        );
        return;
      }

      const dbStatus = mapStatusToDB(body.status);
      const effectiveDate = new Date(body.effectiveDate);

      const updated = await prisma.$transaction(async (tx) => {
        const updateData: Record<string, unknown> = {
          status: dbStatus,
          version: { increment: 1 },
        };

        // For Exited: set exit date and close the open ReportingManagerHistory row
        if (body.status === 'Exited') {
          updateData['exitDate'] = body.exitDate ? new Date(body.exitDate) : effectiveDate;

          // BL-022: close the open history row so pending approvals route to Admin
          await tx.reportingManagerHistory.updateMany({
            where: { employeeId: id, toDate: null },
            data: { toDate: effectiveDate, reason: 'Exited' },
          });

          // SEC-002-P2: revoke every active session for this employee on
          // the spot — they MUST NOT be able to keep using the system on
          // their previous cookie. requireSession also defends in depth
          // by rejecting Exited employees on every request, but pre-emptive
          // deletion makes the access cut clean.
          await tx.session.deleteMany({ where: { employeeId: id } });
        }

        const u = await tx.employee.update({
          where: { id },
          data: updateData as never,
          include: {
            reportingManager: { select: { name: true, code: true } },
            salaryStructures: { orderBy: { effectiveFrom: 'desc' }, take: 1 },
          },
        });

        await audit({
          tx,
          actorId: actor.id,
          actorRole: actor.role,
          actorIp: ip,
          action: 'employee.status.change',
          targetType: 'Employee',
          targetId: id,
          module: 'employees',
          before: { status: mapStatus(current.status), version: current.version },
          after: {
            status: body.status,
            effectiveDate: body.effectiveDate,
            exitDate: body.exitDate ?? null,
            note: body.note ?? null,
            version: u.version,
          },
        });

        // Notify Admin + reporting manager when an employee is marked as Exited
        if (body.status === 'Exited') {
          const notifyTargets: string[] = [];

          // All active Admins
          const admins = await tx.employee.findMany({
            where: { role: 'Admin', status: 'Active' },
            select: { id: true },
          });
          notifyTargets.push(...admins.map((a) => a.id));

          // Reporting manager (if any, and not the exited employee themselves)
          if (current.reportingManagerId && current.reportingManagerId !== id) {
            notifyTargets.push(current.reportingManagerId);
          }

          const uniqueTargets = Array.from(new Set(notifyTargets));
          if (uniqueTargets.length > 0) {
            await notify({
              tx,
              recipientIds: uniqueTargets,
              category: 'Status',
              title: `${current.name} marked as Exited`,
              body: `${current.name} (${current.code}) has been marked as Exited effective ${body.effectiveDate}.`,
              link: `/admin/employees/${id}`,
            });
          }
        }

        return u;
      });

      res.status(200).json({ data: toEmployeeDetail(updated, true) });
    } catch (err: unknown) {
      logger.error({ err }, 'employees.status.change.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to change employee status.'));
    }
  },
);

// ── POST /:id/reassign-manager ────────────────────────────────────────────────
// Reassign reporting manager (Admin only). Cycle check via BL-005.

router.post(
  '/:id/reassign-manager',
  requireSession(),
  requireRole('Admin'),
  validateBody(ReassignManagerRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      newManagerId: string | null;
      effectiveDate: string;
      note?: string;
      version: number;
    };
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      const current = await fetchEmployeeDetail(id);

      if (!current) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      // Optimistic concurrency check
      if (current.version !== body.version) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VERSION_MISMATCH, 'Record has been modified by another user. Reload and retry.', {
            details: { expectedVersion: body.version, actualVersion: current.version },
          }),
        );
        return;
      }

      // Validate newManagerId exists if provided
      if (body.newManagerId) {
        const mgr = await prisma.employee.findUnique({
          where: { id: body.newManagerId },
        });
        if (!mgr) {
          res.status(400).json(
            errorEnvelope(ErrorCode.VALIDATION_FAILED, 'newManagerId does not exist.', {
              details: { newManagerId: ['Employee not found.'] },
            }),
          );
          return;
        }
      }

      // BL-005: circular reporting chain detection
      const cycle = await wouldCreateCycle(id, body.newManagerId);
      if (cycle) {
        res.status(409).json(
          errorEnvelope(
            ErrorCode.CIRCULAR_REPORTING,
            'Assigning this manager would create a circular reporting chain (BL-005).',
            { ruleId: 'BL-005', details: { newManagerId: body.newManagerId } },
          ),
        );
        return;
      }

      const effectiveDate = new Date(body.effectiveDate);
      const oldManagerId = current.reportingManagerId;

      const updated = await prisma.$transaction(async (tx) => {
        // Close the current open history row
        await tx.reportingManagerHistory.updateMany({
          where: { employeeId: id, toDate: null },
          data: { toDate: effectiveDate, reason: 'Reassigned' },
        });

        // Insert a new open history row for the new manager
        await tx.reportingManagerHistory.create({
          data: {
            employeeId: id,
            managerId: body.newManagerId ?? null,
            fromDate: effectiveDate,
            toDate: null,
            reason: 'Reassigned',
          },
        });

        // Update the employee record
        const u = await tx.employee.update({
          where: { id },
          data: {
            reportingManagerId: body.newManagerId ?? null,
            previousReportingManagerId: oldManagerId ?? null,
            version: { increment: 1 },
          },
          include: {
            reportingManager: { select: { name: true, code: true } },
            salaryStructures: { orderBy: { effectiveFrom: 'desc' }, take: 1 },
          },
        });

        // BL-042: propagate manager change to every open PerformanceReview for this employee
        await handleManagerChange(id, oldManagerId ?? null, body.newManagerId ?? null, actor.id, actor.role, ip, tx);

        await audit({
          tx,
          actorId: actor.id,
          actorRole: actor.role,
          actorIp: ip,
          action: 'employee.reassign-manager',
          targetType: 'Employee',
          targetId: id,
          module: 'employees',
          before: { reportingManagerId: oldManagerId ?? null },
          after: {
            reportingManagerId: body.newManagerId ?? null,
            previousReportingManagerId: oldManagerId ?? null,
            effectiveDate: body.effectiveDate,
            note: body.note ?? null,
          },
        });

        // Notify old manager and new manager about the reassignment
        const reassignTargets = [oldManagerId, body.newManagerId].filter(
          (mid): mid is string => mid !== null && mid !== undefined,
        );
        if (reassignTargets.length > 0) {
          // Fetch new manager name for the message
          let newMgrName: string | null = null;
          if (body.newManagerId) {
            const newMgr = await tx.employee.findUnique({
              where: { id: body.newManagerId },
              select: { name: true },
            });
            newMgrName = newMgr?.name ?? null;
          }
          const toMgrMsg = newMgrName ? ` to ${newMgrName}` : '';
          await notify({
            tx,
            recipientIds: Array.from(new Set(reassignTargets)),
            category: 'Status',
            title: `${current.name} has been reassigned`,
            body: `${current.name} (${current.code}) has been reassigned${toMgrMsg}.`,
            link: `/admin/employees/${id}`,
          });
        }

        return u;
      });

      res.status(200).json({ data: toEmployeeDetail(updated, true) });
    } catch (err: unknown) {
      logger.error({ err }, 'employees.reassign-manager.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to reassign manager.'));
    }
  },
);

// ── GET /:id/team ─────────────────────────────────────────────────────────────
// Get current + past team members. Manager (own id only) or Admin.

router.get(
  '/:id/team',
  requireSession(),
  requireRole('Manager', 'Admin'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const actor = req.user!;

    try {
      // Manager can only see their own team
      if (actor.role === 'Manager' && actor.id !== id) {
        res.status(403).json(
          errorEnvelope(ErrorCode.FORBIDDEN, 'Managers may only view their own team.'),
        );
        return;
      }

      // Check the manager exists
      const manager = await prisma.employee.findUnique({
        where: { id },
        select: { id: true, role: true },
      });
      if (!manager) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      // Get all current subordinate IDs (direct + indirect)
      const allSubordinateIds = await getSubordinateIds(id);

      // Determine direct reports
      const directReports = await prisma.employee.findMany({
        where: { reportingManagerId: id },
        select: { id: true },
      });
      const directIds = new Set(directReports.map((r) => r.id));

      // Fetch current team members with data
      const currentMembers = await prisma.employee.findMany({
        where: { id: { in: allSubordinateIds } },
        include: { reportingManager: { select: { name: true, code: true } } },
        orderBy: { name: 'asc' },
      });

      const current: TeamMember[] = currentMembers.map((emp) => ({
        id: emp.id,
        code: emp.code,
        name: emp.name,
        email: emp.email,
        role: emp.role as TeamMember['role'],
        status: mapStatus(emp.status),
        employmentType: emp.employmentType as TeamMember['employmentType'],
        department: emp.department,
        designation: emp.designation,
        reportingManagerName: emp.reportingManager?.name ?? null,
        joinDate: emp.joinDate.toISOString().split('T')[0]!,
        isDirect: directIds.has(emp.id),
        pastEndedAt: null,
        pastReason: null,
      }));

      // Get past team members
      const pastRows = await getPastTeamMembers(id);

      // De-duplicate: a past member who is still current should only appear in current
      const currentIdSet = new Set(allSubordinateIds);
      const past: TeamMember[] = pastRows
        .filter((row) => !currentIdSet.has(row.id))
        .map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          email: row.email,
          role: row.role as TeamMember['role'],
          status: mapStatus(row.status),
          employmentType: row.employmentType as TeamMember['employmentType'],
          department: row.department,
          designation: row.designation,
          reportingManagerName: null, // past members — we don't join their current manager
          joinDate: row.joinDate.toISOString().split('T')[0]!,
          isDirect: false, // past = no longer direct
          pastEndedAt: row.toDate ? row.toDate.toISOString() : null,
          pastReason: row.reason as 'Reassigned' | 'Exited',
        }));

      res.status(200).json({ data: { current, past } });
    } catch (err: unknown) {
      logger.error({ err }, 'employees.team.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to fetch team.'));
    }
  },
);

// ── GET /:id/profile ──────────────────────────────────────────────────────────
// Read-only profile view for SELF or Admin.

router.get(
  '/:id/profile',
  requireSession(),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const actor = req.user!;

    try {
      // Only SELF or Admin may access the profile endpoint
      if (actor.id !== id && actor.role !== 'Admin') {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      const emp = await fetchEmployeeDetail(id);
      if (!emp) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      // Both Admin and SELF see the full salary detail on the profile endpoint
      res.status(200).json({ data: toEmployeeDetail(emp, true) });
    } catch (err: unknown) {
      logger.error({ err }, 'employees.profile.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to fetch profile.'));
    }
  },
);

export { router as employeesRouter };
