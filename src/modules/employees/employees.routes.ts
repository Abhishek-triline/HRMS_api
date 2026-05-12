/**
 * Employees & Hierarchy router — mounted at /api/v1/employees.
 *
 * Endpoints (docs/HRMS_API.md § 5):
 *   POST   /                      A-04 / D-02   Admin only
 *   GET    /                      A-03 / M-02   Admin / Manager (scoped to team)
 *   GET    /:id                   A-04, M-02    Admin / Manager-team / SELF
 *   PATCH  /:id                   D-02          Admin only (optimistic concurrency)
 *   PATCH  /:id/salary            D-04          Admin only — inserts new salary row (BL-030)
 *   POST   /:id/status            D-02          Admin only — Active / OnNotice / Exited (BL-006)
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
import {
  EmployeeStatus,
  RoleId,
  TokenPurpose,
  ReportingHistoryReason,
  type RoleIdValue,
} from '../../lib/statusInt.js';
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

type EmployeeWithRelations = {
  id: number;
  code: string;
  name: string;
  email: string;
  phone: string | null;
  dateOfBirth: Date | null;
  genderId: number | null;
  roleId: number;
  status: number;
  employmentTypeId: number;
  departmentId: number | null;
  department: { name: string } | null;
  designationId: number | null;
  designation: { name: string } | null;
  reportingManagerId: number | null;
  previousReportingManagerId: number | null;
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
    hraPaise: number | null;
    transportPaise: number | null;
    otherPaise: number | null;
  }>;
};

/**
 * Shape a DB employee row into the EmployeeDetail contract response shape.
 * includeSalary=false means the salaryStructure field is null (Manager view).
 */
function toEmployeeDetail(
  emp: EmployeeWithRelations,
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
    phone: emp.phone ?? null,
    dateOfBirth: emp.dateOfBirth ? emp.dateOfBirth.toISOString().split('T')[0]! : null,
    genderId: emp.genderId ?? null,
    roleId: emp.roleId,
    status: emp.status,
    employmentTypeId: emp.employmentTypeId,
    departmentId: emp.departmentId ?? null,
    department: emp.department?.name ?? null,
    designationId: emp.designationId ?? null,
    designation: emp.designation?.name ?? null,
    reportingManagerId: emp.reportingManagerId ?? null,
    reportingManagerName: emp.reportingManager?.name ?? null,
    reportingManagerCode: emp.reportingManager?.code ?? null,
    joinDate: emp.joinDate.toISOString().split('T')[0]!,
    exitDate: emp.exitDate ? emp.exitDate.toISOString().split('T')[0]! : null,
    salaryStructure: activeSalary
      ? {
          basic_paise: activeSalary.basicPaise,
          allowances_paise: activeSalary.allowancesPaise,
          effectiveFrom: activeSalary.effectiveFrom.toISOString().split('T')[0]!,
          hra_paise: activeSalary.hraPaise ?? null,
          transport_paise: activeSalary.transportPaise ?? null,
          other_paise: activeSalary.otherPaise ?? null,
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
async function fetchEmployeeDetail(id: number) {
  return prisma.employee.findUnique({
    where: { id },
    include: {
      department: { select: { name: true } },
      designation: { select: { name: true } },
      reportingManager: { select: { name: true, code: true } },
      salaryStructures: {
        orderBy: { effectiveFrom: 'desc' },
        take: 1,
        select: {
          basicPaise: true,
          allowancesPaise: true,
          effectiveFrom: true,
          hraPaise: true,
          transportPaise: true,
          otherPaise: true,
        },
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
  requireRole(RoleId.Admin),
  validateBody(CreateEmployeeRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as {
      name: string;
      email: string;
      phone?: string | null;
      dateOfBirth?: string | null;
      genderId?: number | null;
      roleId: number;
      departmentId: number;
      designationId: number;
      employmentTypeId: number;
      reportingManagerId: number | null;
      joinDate: string;
      salaryStructure: {
        basic_paise: number;
        allowances_paise: number;
        effectiveFrom: string;
        hra_paise?: number | null;
        transport_paise?: number | null;
        other_paise?: number | null;
      };
    };
    const actor = req.user!;
    const ip = clientIp(req);

    try {
      // Validate reportingManagerId — existence, role, and status (BL-015 / BL-017 / BL-022)
      if (body.reportingManagerId) {
        const mgr = await prisma.employee.findUnique({
          where: { id: body.reportingManagerId },
          select: { id: true, roleId: true, status: true },
        });
        if (!mgr) {
          res.status(400).json(
            errorEnvelope(ErrorCode.VALIDATION_FAILED, 'reportingManagerId does not exist.', {
              details: { reportingManagerId: ['Employee not found.'] },
            }),
          );
          return;
        }
        // Role-of-manager constraint depends on the role of the employee being created.
        // Admins may only report to another Admin. Manager/Employee/PayrollOfficer may
        // report to a Manager or Admin.
        const requireAdminManager = body.roleId === RoleId.Admin;
        const allowedMgrRoleIds = requireAdminManager
          ? [RoleId.Admin]
          : [RoleId.Manager, RoleId.Admin];
        if (!allowedMgrRoleIds.includes(mgr.roleId as typeof RoleId.Admin)) {
          res.status(400).json(
            errorEnvelope(
              ErrorCode.VALIDATION_FAILED,
              requireAdminManager
                ? 'An Admin can only report to another Admin.'
                : 'Reporting manager must have role Manager or Admin.',
              {
                details: {
                  reportingManagerId: [
                    requireAdminManager
                      ? `An Admin can only report to another Admin (got roleId ${mgr.roleId}).`
                      : `Must be a Manager or Admin (got roleId ${mgr.roleId}).`,
                  ],
                },
              },
            ),
          );
          return;
        }
        if (
          mgr.status === EmployeeStatus.Exited ||
          mgr.status === EmployeeStatus.Inactive
        ) {
          res.status(400).json(
            errorEnvelope(
              ErrorCode.VALIDATION_FAILED,
              'Reporting manager must be Active or OnNotice.',
              {
                details: {
                  reportingManagerId: ['Cannot assign an Exited or Inactive employee.'],
                },
              },
            ),
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

      // Validate allowance component breakdown when any component field is provided
      const sal = body.salaryStructure;
      const componentFieldsPresent = [sal.hra_paise, sal.transport_paise, sal.other_paise].filter(
        (v) => v !== undefined && v !== null,
      );
      if (componentFieldsPresent.length > 0) {
        if (componentFieldsPresent.length !== 3) {
          res.status(400).json(
            errorEnvelope(
              ErrorCode.VALIDATION_FAILED,
              'When providing allowance breakdown, all three fields must be present.',
              { details: { salaryStructure: ['hra_paise, transport_paise, and other_paise must all be provided together.'] } },
            ),
          );
          return;
        }
        const componentSum =
          (sal.hra_paise ?? 0) + (sal.transport_paise ?? 0) + (sal.other_paise ?? 0);
        if (componentSum !== sal.allowances_paise) {
          res.status(400).json(
            errorEnvelope(
              ErrorCode.VALIDATION_FAILED,
              `Allowance components sum (${componentSum} paise) must equal allowances_paise (${sal.allowances_paise} paise).`,
              { details: { salaryStructure: ['hra_paise + transport_paise + other_paise must equal allowances_paise.'] } },
            ),
          );
          return;
        }
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
            roleId: body.roleId,
            status: EmployeeStatus.Inactive,
            employmentTypeId: body.employmentTypeId,
            departmentId: body.departmentId,
            designationId: body.designationId,
            phone: body.phone ?? null,
            dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null,
            genderId: body.genderId ?? null,
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
            hraPaise: body.salaryStructure.hra_paise ?? null,
            transportPaise: body.salaryStructure.transport_paise ?? null,
            otherPaise: body.salaryStructure.other_paise ?? null,
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
            reasonId: ReportingHistoryReason.Initial,
          },
        });

        // Create first-login token
        await tx.passwordResetToken.create({
          data: {
            employeeId: newEmp.id,
            tokenHash,
            purposeId: TokenPurpose.FirstLogin,
            expiresAt,
          },
        });

        // Audit employee creation
        await audit({
          tx,
          actorId: actor.id,
          actorRole: actor.roleId as RoleIdValue,
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
            roleId: newEmp.roleId,
            status: newEmp.status,
            employmentTypeId: newEmp.employmentTypeId,
            departmentId: newEmp.departmentId,
            designationId: newEmp.designationId,
            reportingManagerId: newEmp.reportingManagerId,
            joinDate: body.joinDate,
          },
        });

        return newEmp;
      });

      // Send invitation email (fire-and-forget)
      const inviteUrl = `${WEB_BASE_URL}/first-login?token=${rawToken}`;
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

      // Fetch the full detail for the response
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
  requireRole(RoleId.Admin, RoleId.Manager),
  validateQuery(EmployeeListQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as {
      cursor?: string;
      limit?: number;
      status?: number;
      roleId?: string;
      departmentId?: number;
      employmentTypeId?: number;
      managerId?: number;
      q?: string;
      sort?: string;
    };
    const actor = req.user!;

    try {
      const limit = Number(query.limit ?? 20);

      // Manager scope: only their direct + indirect reports
      let allowedIds: number[] | null = null;
      if (actor.roleId === RoleId.Manager) {
        allowedIds = await getSubordinateIds(actor.id);

        // If a managerId filter is provided, it must match self (BL-022)
        if (query.managerId && Number(query.managerId) !== actor.id) {
          res.status(403).json(
            errorEnvelope(ErrorCode.FORBIDDEN, 'Managers may only filter by their own team.'),
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
        where['status'] = Number(query.status);
      }

      if (query.roleId) {
        const roles = String(query.roleId).split(',').map((r) => Number(r.trim())).filter(Boolean);
        where['roleId'] = roles.length === 1 ? roles[0] : { in: roles };
      }

      if (query.departmentId) {
        where['departmentId'] = Number(query.departmentId);
      }

      if (query.employmentTypeId) {
        where['employmentTypeId'] = Number(query.employmentTypeId);
      }

      if (query.managerId && actor.roleId === RoleId.Admin) {
        where['reportingManagerId'] = Number(query.managerId);
      }

      if (query.q) {
        where['OR'] = [
          { name: { contains: query.q } },
          { email: { contains: query.q } },
          { code: { contains: query.q } },
        ];
      }

      // Cursor pagination
      if (query.cursor) {
        const cursorId = Number(query.cursor);
        if (!isNaN(cursorId)) {
          const cursorConstraint =
            allowedIds !== null
              ? { id: cursorId, ...(allowedIds.includes(cursorId) ? {} : { id: -1 }) }
              : { id: cursorId };
          const cursorEmp = await prisma.employee.findFirst({
            where: cursorConstraint,
            select: { name: true },
          });
          if (cursorEmp) {
            where['name'] = { gt: cursorEmp.name };
          }
        }
      }

      // Sort
      const sortField = query.sort ?? 'name';
      const sortDir = String(sortField).startsWith('-') ? 'desc' : 'asc';
      const sortKey = String(sortField).replace(/^-/, '');
      const allowedSortKeys = ['name', 'email', 'code', 'joinDate', 'status'];
      const finalSortKey = allowedSortKeys.includes(sortKey) ? sortKey : 'name';

      const employees = await prisma.employee.findMany({
        where,
        include: {
          department: { select: { name: true } },
          designation: { select: { name: true } },
          reportingManager: { select: { name: true, code: true } },
        },
        orderBy: { [finalSortKey]: sortDir },
        take: limit + 1,
      });

      const hasNextPage = employees.length > limit;
      const items = hasNextPage ? employees.slice(0, limit) : employees;
      const nextCursor = hasNextPage ? String(items[items.length - 1]!.id) : null;

      const data: EmployeeListItem[] = items.map((emp) => ({
        id: emp.id,
        code: emp.code,
        name: emp.name,
        email: emp.email,
        roleId: emp.roleId,
        status: emp.status,
        employmentTypeId: emp.employmentTypeId,
        departmentId: emp.departmentId ?? null,
        department: emp.department?.name ?? null,
        designationId: emp.designationId ?? null,
        designation: emp.designation?.name ?? null,
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
    const id = Number(req.params['id']);
    const actor = req.user!;

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
      return;
    }

    try {
      const emp = await fetchEmployeeDetail(id);

      if (!emp) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      const isSelf = actor.id === id;
      const isAdmin = actor.roleId === RoleId.Admin;

      let canView = false;
      let includeSalary = false;

      if (isAdmin) {
        canView = true;
        includeSalary = true;
      } else if (isSelf) {
        canView = true;
        includeSalary = true;
      } else if (actor.roleId === RoleId.Manager) {
        const subordinates = await getSubordinateIds(actor.id);
        if (subordinates.includes(id)) {
          canView = true;
          includeSalary = false;
        }
      }

      if (!canView) {
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
  requireRole(RoleId.Admin),
  validateBody(UpdateEmployeeRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params['id']);
    const body = req.body as {
      name?: string;
      phone?: string | null;
      dateOfBirth?: string | null;
      genderId?: number | null;
      roleId?: number;
      departmentId?: number;
      designationId?: number;
      employmentTypeId?: number;
      joinDate?: string;
      reportingManagerId?: number | null;
      version: number;
    };
    const actor = req.user!;
    const ip = clientIp(req);

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
      return;
    }

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

      const managerChanging = body.reportingManagerId !== undefined;
      const newManagerId = managerChanging ? (body.reportingManagerId ?? null) : undefined;

      if (managerChanging && newManagerId !== null) {
        const mgr = await prisma.employee.findUnique({
          where: { id: newManagerId },
          select: { id: true, roleId: true, status: true },
        });
        if (!mgr) {
          res.status(400).json(
            errorEnvelope(ErrorCode.VALIDATION_FAILED, 'reportingManagerId does not exist.', {
              details: { reportingManagerId: ['Employee not found.'] },
            }),
          );
          return;
        }
        const effectiveRoleId = body.roleId ?? current.roleId;
        const requireAdminManager = effectiveRoleId === RoleId.Admin;
        const allowedMgrRoleIds = requireAdminManager
          ? [RoleId.Admin]
          : [RoleId.Manager, RoleId.Admin];
        if (!allowedMgrRoleIds.includes(mgr.roleId as typeof RoleId.Admin)) {
          res.status(400).json(
            errorEnvelope(
              ErrorCode.VALIDATION_FAILED,
              requireAdminManager
                ? 'An Admin can only report to another Admin.'
                : 'Reporting manager must have role Manager or Admin.',
              {
                details: {
                  reportingManagerId: [
                    requireAdminManager
                      ? `An Admin can only report to another Admin (got roleId ${mgr.roleId}).`
                      : `Must be a Manager or Admin (got roleId ${mgr.roleId}).`,
                  ],
                },
              },
            ),
          );
          return;
        }
        if (
          mgr.status === EmployeeStatus.Exited ||
          mgr.status === EmployeeStatus.Inactive
        ) {
          res.status(400).json(
            errorEnvelope(
              ErrorCode.VALIDATION_FAILED,
              'Reporting manager must be Active or OnNotice.',
              {
                details: { reportingManagerId: ['Cannot assign an Exited or Inactive employee.'] },
              },
            ),
          );
          return;
        }

        // BL-005: circular reporting chain detection
        const cycle = await wouldCreateCycle(id, newManagerId ?? null);
        if (cycle) {
          res.status(409).json(
            errorEnvelope(
              ErrorCode.CIRCULAR_REPORTING,
              'Assigning this manager would create a circular reporting chain (BL-005).',
              { ruleId: 'BL-005', details: { reportingManagerId: newManagerId } },
            ),
          );
          return;
        }
      }

      const beforeSnapshot = {
        name: current.name,
        phone: current.phone,
        dateOfBirth: current.dateOfBirth,
        genderId: current.genderId,
        roleId: current.roleId,
        departmentId: current.departmentId,
        designationId: current.designationId,
        employmentTypeId: current.employmentTypeId,
        joinDate: current.joinDate.toISOString().split('T')[0],
        reportingManagerId: current.reportingManagerId,
        version: current.version,
      };

      const updateData: Record<string, unknown> = {
        version: { increment: 1 },
      };
      if (body.name !== undefined) updateData['name'] = body.name;
      if (body.phone !== undefined) updateData['phone'] = body.phone ?? null;
      if (body.dateOfBirth !== undefined)
        updateData['dateOfBirth'] = body.dateOfBirth ? new Date(body.dateOfBirth) : null;
      if (body.genderId !== undefined) updateData['genderId'] = body.genderId ?? null;
      if (body.roleId !== undefined) updateData['roleId'] = body.roleId;
      if (body.departmentId !== undefined) updateData['departmentId'] = body.departmentId;
      if (body.designationId !== undefined) updateData['designationId'] = body.designationId;
      if (body.employmentTypeId !== undefined) updateData['employmentTypeId'] = body.employmentTypeId;
      if (body.joinDate !== undefined) updateData['joinDate'] = new Date(body.joinDate);
      if (managerChanging) {
        updateData['reportingManagerId'] = newManagerId ?? null;
        if (current.reportingManagerId !== null) {
          updateData['previousReportingManagerId'] = current.reportingManagerId;
        }
      }

      const now = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        if (managerChanging) {
          // Close the currently open history row
          await tx.reportingManagerHistory.updateMany({
            where: { employeeId: id, toDate: null },
            data: { toDate: now, reasonId: ReportingHistoryReason.Reassigned },
          });

          // Open a new history row for the incoming manager
          await tx.reportingManagerHistory.create({
            data: {
              employeeId: id,
              managerId: newManagerId ?? null,
              fromDate: now,
              toDate: null,
              reasonId: ReportingHistoryReason.Reassigned,
            },
          });
        }

        const u = await tx.employee.update({
          where: { id },
          data: updateData as never,
          include: {
            department: { select: { name: true } },
            designation: { select: { name: true } },
            reportingManager: { select: { name: true, code: true } },
            salaryStructures: { orderBy: { effectiveFrom: 'desc' }, take: 1 },
          },
        });

        await audit({
          tx,
          actorId: actor.id,
          actorRole: actor.roleId as RoleIdValue,
          actorIp: ip,
          action: 'employee.update',
          targetType: 'Employee',
          targetId: id,
          module: 'employees',
          before: beforeSnapshot,
          after: {
            name: u.name,
            phone: u.phone,
            dateOfBirth: u.dateOfBirth ? u.dateOfBirth.toISOString().split('T')[0] : null,
            genderId: u.genderId,
            roleId: u.roleId,
            departmentId: u.departmentId,
            designationId: u.designationId,
            employmentTypeId: u.employmentTypeId,
            joinDate: u.joinDate.toISOString().split('T')[0],
            reportingManagerId: u.reportingManagerId,
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
  requireRole(RoleId.Admin),
  validateBody(UpdateSalaryRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params['id']);
    const body = req.body as {
      basic_paise: number;
      allowances_paise: number;
      effectiveFrom: string;
      hra_paise?: number | null;
      transport_paise?: number | null;
      other_paise?: number | null;
      version: number;
    };
    const actor = req.user!;
    const ip = clientIp(req);

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
      return;
    }

    try {
      const current = await fetchEmployeeDetail(id);

      if (!current) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      if (current.version !== body.version) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VERSION_MISMATCH, 'Record has been modified by another user. Reload and retry.', {
            details: { expectedVersion: body.version, actualVersion: current.version },
          }),
        );
        return;
      }

      const componentFieldsPresent = [body.hra_paise, body.transport_paise, body.other_paise].filter(
        (v) => v !== undefined && v !== null,
      );
      if (componentFieldsPresent.length > 0) {
        if (componentFieldsPresent.length !== 3) {
          res.status(400).json(
            errorEnvelope(
              ErrorCode.VALIDATION_FAILED,
              'When providing allowance breakdown, all three fields must be present.',
              { details: { salaryStructure: ['hra_paise, transport_paise, and other_paise must all be provided together.'] } },
            ),
          );
          return;
        }
        const componentSum =
          (body.hra_paise ?? 0) + (body.transport_paise ?? 0) + (body.other_paise ?? 0);
        if (componentSum !== body.allowances_paise) {
          res.status(400).json(
            errorEnvelope(
              ErrorCode.VALIDATION_FAILED,
              `Allowance components sum (${componentSum} paise) must equal allowances_paise (${body.allowances_paise} paise).`,
              { details: { salaryStructure: ['hra_paise + transport_paise + other_paise must equal allowances_paise.'] } },
            ),
          );
          return;
        }
      }

      const currentSalary = current.salaryStructures?.[0] ?? null;

      const updated = await prisma.$transaction(async (tx) => {
        await tx.salaryStructure.create({
          data: {
            employeeId: id,
            basicPaise: body.basic_paise,
            allowancesPaise: body.allowances_paise,
            effectiveFrom: new Date(body.effectiveFrom),
            hraPaise: body.hra_paise ?? null,
            transportPaise: body.transport_paise ?? null,
            otherPaise: body.other_paise ?? null,
            version: 0,
          },
        });

        const u = await tx.employee.update({
          where: { id },
          data: { version: { increment: 1 } },
          include: {
            department: { select: { name: true } },
            designation: { select: { name: true } },
            reportingManager: { select: { name: true, code: true } },
            salaryStructures: { orderBy: { effectiveFrom: 'desc' }, take: 1 },
          },
        });

        await audit({
          tx,
          actorId: actor.id,
          actorRole: actor.roleId as RoleIdValue,
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
  requireRole(RoleId.Admin),
  validateBody(ChangeStatusRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params['id']);
    const body = req.body as {
      status: number; // 1=Active, 2=OnNotice, 5=Exited
      effectiveDate: string;
      exitDate?: string;
      note?: string;
      version: number;
    };
    const actor = req.user!;
    const ip = clientIp(req);

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
      return;
    }

    try {
      const current = await fetchEmployeeDetail(id);

      if (!current) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      if (current.version !== body.version) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VERSION_MISMATCH, 'Record has been modified by another user. Reload and retry.', {
            details: { expectedVersion: body.version, actualVersion: current.version },
          }),
        );
        return;
      }

      // BL-006: On-Leave (3) is system-set only — refuse it explicitly
      if (body.status === EmployeeStatus.OnLeave) {
        res.status(400).json(
          errorEnvelope(
            ErrorCode.VALIDATION_FAILED,
            'The On-Leave status is system-controlled and cannot be set manually (BL-006).',
            { ruleId: 'BL-006' },
          ),
        );
        return;
      }

      const effectiveDate = new Date(body.effectiveDate);

      const updated = await prisma.$transaction(async (tx) => {
        const updateData: Record<string, unknown> = {
          status: body.status,
          version: { increment: 1 },
        };

        if (body.status === EmployeeStatus.Exited) {
          updateData['exitDate'] = body.exitDate ? new Date(body.exitDate) : effectiveDate;

          // BL-022: close the open history row
          await tx.reportingManagerHistory.updateMany({
            where: { employeeId: id, toDate: null },
            data: { toDate: effectiveDate, reasonId: ReportingHistoryReason.Exited },
          });

          // Revoke all sessions for this employee immediately
          await tx.session.deleteMany({ where: { employeeId: id } });
        }

        const u = await tx.employee.update({
          where: { id },
          data: updateData as never,
          include: {
            department: { select: { name: true } },
            designation: { select: { name: true } },
            reportingManager: { select: { name: true, code: true } },
            salaryStructures: { orderBy: { effectiveFrom: 'desc' }, take: 1 },
          },
        });

        await audit({
          tx,
          actorId: actor.id,
          actorRole: actor.roleId as RoleIdValue,
          actorIp: ip,
          action: 'employee.status.change',
          targetType: 'Employee',
          targetId: id,
          module: 'employees',
          before: { status: current.status, version: current.version },
          after: {
            status: body.status,
            effectiveDate: body.effectiveDate,
            exitDate: body.exitDate ?? null,
            note: body.note ?? null,
            version: u.version,
          },
        });

        if (body.status === EmployeeStatus.Exited) {
          const notifyTargets: number[] = [];

          const admins = await tx.employee.findMany({
            where: { roleId: RoleId.Admin, status: EmployeeStatus.Active },
            select: { id: true },
          });
          notifyTargets.push(...admins.map((a) => a.id));

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
  requireRole(RoleId.Admin),
  validateBody(ReassignManagerRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params['id']);
    const body = req.body as {
      newManagerId: number | null;
      effectiveDate: string;
      note?: string;
      version: number;
    };
    const actor = req.user!;
    const ip = clientIp(req);

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
      return;
    }

    try {
      const current = await fetchEmployeeDetail(id);

      if (!current) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      if (current.version !== body.version) {
        res.status(409).json(
          errorEnvelope(ErrorCode.VERSION_MISMATCH, 'Record has been modified by another user. Reload and retry.', {
            details: { expectedVersion: body.version, actualVersion: current.version },
          }),
        );
        return;
      }

      if (body.newManagerId !== null) {
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
          data: { toDate: effectiveDate, reasonId: ReportingHistoryReason.Reassigned },
        });

        // Insert a new open history row for the new manager
        await tx.reportingManagerHistory.create({
          data: {
            employeeId: id,
            managerId: body.newManagerId ?? null,
            fromDate: effectiveDate,
            toDate: null,
            reasonId: ReportingHistoryReason.Reassigned,
          },
        });

        const u = await tx.employee.update({
          where: { id },
          data: {
            reportingManagerId: body.newManagerId ?? null,
            previousReportingManagerId: oldManagerId ?? null,
            version: { increment: 1 },
          },
          include: {
            department: { select: { name: true } },
            designation: { select: { name: true } },
            reportingManager: { select: { name: true, code: true } },
            salaryStructures: { orderBy: { effectiveFrom: 'desc' }, take: 1 },
          },
        });

        // BL-042: propagate manager change to open PerformanceReviews
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await handleManagerChange(id as any, oldManagerId ?? null, body.newManagerId ?? null, actor.id as any, actor.roleId as any, ip, tx);

        await audit({
          tx,
          actorId: actor.id,
          actorRole: actor.roleId as RoleIdValue,
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

        const reassignTargets = [oldManagerId, body.newManagerId].filter(
          (mid): mid is number => mid !== null && mid !== undefined,
        );
        if (reassignTargets.length > 0) {
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
  requireRole(RoleId.Manager, RoleId.Admin),
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params['id']);
    const actor = req.user!;

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
      return;
    }

    try {
      // Manager can only see their own team
      if (actor.roleId === RoleId.Manager && actor.id !== id) {
        res.status(403).json(
          errorEnvelope(ErrorCode.FORBIDDEN, 'Managers may only view their own team.'),
        );
        return;
      }

      const manager = await prisma.employee.findUnique({
        where: { id },
        select: { id: true, roleId: true },
      });
      if (!manager) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      const allSubordinateIds = await getSubordinateIds(id);

      const directReports = await prisma.employee.findMany({
        where: { reportingManagerId: id },
        select: { id: true },
      });
      const directIds = new Set(directReports.map((r) => r.id));

      const currentMembers = await prisma.employee.findMany({
        where: { id: { in: allSubordinateIds } },
        include: {
          department: { select: { name: true } },
          designation: { select: { name: true } },
          reportingManager: { select: { name: true, code: true } },
        },
        orderBy: { name: 'asc' },
      });

      const current: TeamMember[] = currentMembers.map((emp) => ({
        id: emp.id,
        code: emp.code,
        name: emp.name,
        email: emp.email,
        roleId: emp.roleId,
        status: emp.status,
        employmentTypeId: emp.employmentTypeId,
        departmentId: emp.departmentId ?? null,
        department: emp.department?.name ?? null,
        designationId: emp.designationId ?? null,
        designation: emp.designation?.name ?? null,
        reportingManagerName: emp.reportingManager?.name ?? null,
        joinDate: emp.joinDate.toISOString().split('T')[0]!,
        isDirect: directIds.has(emp.id),
        pastEndedAt: null,
        pastReasonId: null,
      }));

      const pastRows = await getPastTeamMembers(id);

      const currentIdSet = new Set(allSubordinateIds);
      const past: TeamMember[] = pastRows
        .filter((row) => !currentIdSet.has(row.id))
        .map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          email: row.email,
          roleId: row.roleId,
          status: row.status,
          employmentTypeId: row.employmentTypeId,
          departmentId: row.departmentId ?? null,
          department: row.department ?? null,
          designationId: row.designationId ?? null,
          designation: row.designation ?? null,
          reportingManagerName: null,
          joinDate: row.joinDate.toISOString().split('T')[0]!,
          isDirect: false,
          pastEndedAt: row.toDate ? row.toDate.toISOString() : null,
          pastReasonId: row.reasonId as 2 | 3,
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
    const id = Number(req.params['id']);
    const actor = req.user!;

    if (isNaN(id)) {
      res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
      return;
    }

    try {
      if (actor.id !== id && actor.roleId !== RoleId.Admin) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      const emp = await fetchEmployeeDetail(id);
      if (!emp) {
        res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Employee not found.'));
        return;
      }

      res.status(200).json({ data: toEmployeeDetail(emp, true) });
    } catch (err: unknown) {
      logger.error({ err }, 'employees.profile.error');
      res.status(500).json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Failed to fetch profile.'));
    }
  },
);

export { router as employeesRouter };
