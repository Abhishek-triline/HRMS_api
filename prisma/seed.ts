/**
 * Nexora HRMS — Database seed (Schema v2)
 *
 * Idempotent: safe to re-run. Uses upsert for master tables (key on `name`)
 * and findUnique-then-create for accounts (key on `email`).
 *
 * Seeds, in order:
 *   1. Configuration rows (BL defaults)
 *   2. Master tables — Role, EmploymentType, Department, Designation, Gender,
 *      AuditModule, LeaveType (with FROZEN IDs per HRMS_Schema_v2_Plan §2)
 *   3. LeaveQuota rows (4 employment types × 4 accrual leave types)
 *   4. Holiday calendar (current calendar year)
 *   5. Default admin + 3 demo accounts (manager / employee / payroll)
 *   6. SalaryStructure + ReportingManagerHistory for each demo employee
 *   7. LeaveBalance rows for each demo employee × leave type × current year
 */

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load apps/api/.env (env file colocated with the API).
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const prisma = new PrismaClient({ log: ['warn', 'error'] });

// ── Configuration defaults ───────────────────────────────────────────────────

const CONFIG_DEFAULTS: Array<{ key: string; value: unknown }> = [
  { key: 'LATE_THRESHOLD', value: '10:30' },
  { key: 'STANDARD_DAILY_HOURS', value: 8 },
  { key: 'LEAVE_ESCALATION_WORKING_DAYS', value: 5 },
  { key: 'ANNUAL_CARRY_FORWARD_CAP', value: 10 },
  { key: 'CASUAL_CARRY_FORWARD_CAP', value: 5 },
  { key: 'MATERNITY_WEEKS', value: 26 },
  { key: 'PATERNITY_WORKING_DAYS', value: 10 },
  { key: 'NOTIFICATION_RETENTION_DAYS', value: 90 },
  { key: 'STANDARD_TAX_REFERENCE_RATE', value: 0.095 },
  { key: 'TAX_GROSS_TAXABLE_BASIS', value: 'GrossMinusStandardDeduction' },
  // Leave Encashment window (BL-LE-04)
  { key: 'ENCASHMENT_WINDOW_START_MONTH', value: 12 },
  { key: 'ENCASHMENT_WINDOW_END_MONTH',   value: 1  },
  { key: 'ENCASHMENT_WINDOW_END_DAY',     value: 15 },
  { key: 'ENCASHMENT_MAX_PERCENT',        value: 50 },
];

// ── Master table seeds — FROZEN IDs per HRMS_Schema_v2_Plan.md §2 ──────────────
//
// Frozen IDs use INSERT ... ON DUPLICATE KEY UPDATE so re-running the seed
// keeps IDs stable. Production-relevant masters must keep their IDs because
// other tables' INT FK columns reference them by ID.

const ROLES = [
  { id: 1, name: 'Employee' },
  { id: 2, name: 'Manager' },
  { id: 3, name: 'PayrollOfficer' },
  { id: 4, name: 'Admin' },
];

const EMPLOYMENT_TYPES = [
  { id: 1, name: 'Permanent' },
  { id: 2, name: 'Contract' },
  { id: 3, name: 'Probation' },
  { id: 4, name: 'Intern' },
];

const GENDERS = [
  { id: 1, name: 'Male' },
  { id: 2, name: 'Female' },
  { id: 3, name: 'Other' },
  { id: 4, name: 'PreferNotToSay' },
];

const AUDIT_MODULES = [
  { id: 1, name: 'auth' },
  { id: 2, name: 'employees' },
  { id: 3, name: 'leave' },
  { id: 4, name: 'payroll' },
  { id: 5, name: 'attendance' },
  { id: 6, name: 'performance' },
  { id: 7, name: 'notifications' },
  { id: 8, name: 'audit' },
  { id: 9, name: 'configuration' },
];

const DEFAULT_DEPARTMENTS = ['Engineering', 'Design', 'HR', 'Finance', 'Operations', 'Product', 'Sales'];
const DEFAULT_DESIGNATIONS = [
  'Software Engineer',
  'Engineering Manager',
  'Head of People',
  'Payroll Officer',
  'Senior Designer',
  'Product Manager',
];

// ── Leave types — also frozen IDs ─────────────────────────────────────────────

interface LeaveTypeSeed {
  id: number;
  name: string;
  isEventBased: boolean;
  requiresAdminApproval: boolean;
  carryForwardCap: number | null;
  maxDaysPerEvent: number | null;
}

const LEAVE_TYPES: LeaveTypeSeed[] = [
  { id: 1, name: 'Annual',    isEventBased: false, requiresAdminApproval: false, carryForwardCap: 10,  maxDaysPerEvent: null },
  { id: 2, name: 'Sick',      isEventBased: false, requiresAdminApproval: false, carryForwardCap: 0,   maxDaysPerEvent: null },
  { id: 3, name: 'Casual',    isEventBased: false, requiresAdminApproval: false, carryForwardCap: 5,   maxDaysPerEvent: null },
  { id: 4, name: 'Unpaid',    isEventBased: false, requiresAdminApproval: false, carryForwardCap: 0,   maxDaysPerEvent: null },
  { id: 5, name: 'Maternity', isEventBased: true,  requiresAdminApproval: true,  carryForwardCap: null, maxDaysPerEvent: 182 },
  { id: 6, name: 'Paternity', isEventBased: true,  requiresAdminApproval: true,  carryForwardCap: null, maxDaysPerEvent: 10 },
];

// ── Leave quotas (employmentTypeId × leaveTypeName) ──────────────────────────

interface QuotaSeed { leaveTypeId: number; employmentTypeId: number; daysPerYear: number }
const LEAVE_QUOTAS: QuotaSeed[] = [
  // Annual
  { leaveTypeId: 1, employmentTypeId: 1, daysPerYear: 18 }, // Permanent
  { leaveTypeId: 1, employmentTypeId: 2, daysPerYear: 12 }, // Contract
  { leaveTypeId: 1, employmentTypeId: 3, daysPerYear: 6  }, // Probation
  { leaveTypeId: 1, employmentTypeId: 4, daysPerYear: 3  }, // Intern
  // Sick
  { leaveTypeId: 2, employmentTypeId: 1, daysPerYear: 10 },
  { leaveTypeId: 2, employmentTypeId: 2, daysPerYear: 7  },
  { leaveTypeId: 2, employmentTypeId: 3, daysPerYear: 5  },
  { leaveTypeId: 2, employmentTypeId: 4, daysPerYear: 3  },
  // Casual
  { leaveTypeId: 3, employmentTypeId: 1, daysPerYear: 8  },
  { leaveTypeId: 3, employmentTypeId: 2, daysPerYear: 6  },
  { leaveTypeId: 3, employmentTypeId: 3, daysPerYear: 4  },
  { leaveTypeId: 3, employmentTypeId: 4, daysPerYear: 2  },
  // Unpaid — no annual cap (daysPerYear = 0)
  { leaveTypeId: 4, employmentTypeId: 1, daysPerYear: 0  },
  { leaveTypeId: 4, employmentTypeId: 2, daysPerYear: 0  },
  { leaveTypeId: 4, employmentTypeId: 3, daysPerYear: 0  },
  { leaveTypeId: 4, employmentTypeId: 4, daysPerYear: 0  },
];

// ── Holiday calendar (current year — placeholder set) ────────────────────────

const HOLIDAY_SEEDS = [
  { month: 1,  day: 26, name: 'Republic Day' },
  { month: 3,  day: 3,  name: 'Holi' },
  { month: 4,  day: 3,  name: 'Good Friday' },
  { month: 8,  day: 15, name: 'Independence Day' },
  { month: 10, day: 2,  name: 'Gandhi Jayanti' },
  { month: 10, day: 31, name: 'Diwali' },
  { month: 12, day: 25, name: 'Christmas' },
];

// ── Demo account seeds ───────────────────────────────────────────────────────

interface DemoAccountSeed {
  email: string;
  name: string;
  code: string;
  roleId: number;
  designationName: string;
  departmentName: string;
  employmentTypeId: number;
  reportsToEmail: string | null;
}

const ADMIN_EMAIL    = process.env['SEED_ADMIN_EMAIL']    ?? 'admin@triline.co.in';
const ADMIN_PASSWORD = process.env['SEED_ADMIN_PASSWORD'] ?? 'admin@123';
const COMMON_PASSWORD = ADMIN_PASSWORD; // demo accounts share the password for simplicity

const DEMO_ACCOUNTS: DemoAccountSeed[] = [
  { email: ADMIN_EMAIL,             name: 'Priya Sharma', code: 'EMP-2024-0001', roleId: 4, designationName: 'Head of People',     departmentName: 'HR',           employmentTypeId: 1, reportsToEmail: null              },
  { email: 'manager@triline.co.in', name: 'Arjun Mehta',  code: 'EMP-2024-0002', roleId: 2, designationName: 'Engineering Manager', departmentName: 'Engineering', employmentTypeId: 1, reportsToEmail: ADMIN_EMAIL       },
  { email: 'employee@triline.co.in', name: 'Kavya Reddy', code: 'EMP-2024-0003', roleId: 1, designationName: 'Software Engineer',   departmentName: 'Engineering', employmentTypeId: 1, reportsToEmail: 'manager@triline.co.in' },
  { email: 'payroll@triline.co.in', name: 'Ravi Iyer',    code: 'EMP-2024-0004', roleId: 3, designationName: 'Payroll Officer',     departmentName: 'Finance',     employmentTypeId: 1, reportsToEmail: ADMIN_EMAIL       },
];

// ── Seed functions ───────────────────────────────────────────────────────────

async function seedConfiguration(): Promise<void> {
  let created = 0;
  let skipped = 0;
  for (const { key, value } of CONFIG_DEFAULTS) {
    const existing = await prisma.configuration.findUnique({ where: { key } });
    if (existing) { skipped++; continue; }
    await prisma.configuration.create({ data: { key, value: value as never, updatedBy: 'seed' } });
    created++;
    console.log(`  [config] +${key} = ${JSON.stringify(value)}`);
  }
  console.log(`  [config] ${created} created, ${skipped} skipped`);
}

async function seedMasterById<T extends { id: number; name: string }>(
  table: 'role' | 'employmentType' | 'gender' | 'auditModule',
  rows: T[],
): Promise<void> {
  for (const r of rows) {
    // Upsert by id keeps the frozen mapping stable across re-runs.
    // @ts-expect-error — prisma narrows the model union dynamically; this loop
    // calls upsert on whichever table the caller named.
    await prisma[table].upsert({
      where: { id: r.id },
      create: { id: r.id, name: r.name },
      update: { name: r.name },
    });
  }
}

async function seedDepartmentsAndDesignations(): Promise<void> {
  for (const name of DEFAULT_DEPARTMENTS) {
    await prisma.department.upsert({ where: { name }, create: { name }, update: {} });
  }
  for (const name of DEFAULT_DESIGNATIONS) {
    await prisma.designation.upsert({ where: { name }, create: { name }, update: {} });
  }
}

async function seedLeaveTypes(): Promise<void> {
  for (const lt of LEAVE_TYPES) {
    await prisma.leaveType.upsert({
      where: { id: lt.id },
      create: {
        id: lt.id,
        name: lt.name,
        isEventBased: lt.isEventBased,
        requiresAdminApproval: lt.requiresAdminApproval,
        carryForwardCap: lt.carryForwardCap,
        maxDaysPerEvent: lt.maxDaysPerEvent,
      },
      update: {
        name: lt.name,
        isEventBased: lt.isEventBased,
        requiresAdminApproval: lt.requiresAdminApproval,
        carryForwardCap: lt.carryForwardCap,
        maxDaysPerEvent: lt.maxDaysPerEvent,
      },
    });
  }
}

async function seedLeaveQuotas(): Promise<void> {
  for (const q of LEAVE_QUOTAS) {
    await prisma.leaveQuota.upsert({
      where: { leaveTypeId_employmentTypeId: { leaveTypeId: q.leaveTypeId, employmentTypeId: q.employmentTypeId } },
      create: q,
      update: { daysPerYear: q.daysPerYear },
    });
  }
}

async function seedHolidays(year: number): Promise<void> {
  for (const h of HOLIDAY_SEEDS) {
    const date = new Date(Date.UTC(year, h.month - 1, h.day));
    await prisma.holiday.upsert({
      where: { date },
      create: { date, name: h.name, year },
      update: { name: h.name, year },
    });
  }
}

async function seedDemoAccounts(): Promise<void> {
  const passwordHash = await argon2.hash(COMMON_PASSWORD, { type: argon2.argon2id });
  const joinDate = new Date('2024-02-01');

  // First pass: create accounts WITHOUT reportingManagerId so we can resolve emails later.
  for (const acc of DEMO_ACCOUNTS) {
    const existing = await prisma.employee.findUnique({ where: { email: acc.email } });
    if (existing) { console.log(`  [demo] skip existing ${acc.email}`); continue; }

    const dept = await prisma.department.findUnique({ where: { name: acc.departmentName } });
    const desig = await prisma.designation.findUnique({ where: { name: acc.designationName } });

    const emp = await prisma.employee.create({
      data: {
        code: acc.code,
        email: acc.email,
        name: acc.name,
        passwordHash,
        roleId: acc.roleId,
        employmentTypeId: acc.employmentTypeId,
        departmentId: dept?.id ?? null,
        designationId: desig?.id ?? null,
        statusId: 1, // Active
        joinDate,
        mustResetPassword: false,
        version: 0,
      },
    });

    // Initial salary structure (zero — Admin updates later).
    await prisma.salaryStructure.create({
      data: {
        employeeId: emp.id,
        basicPaise: 0,
        allowancesPaise: 0,
        effectiveFrom: joinDate,
        version: 0,
      },
    });

    // Reporting-manager history row (Initial — manager unresolved at this point).
    await prisma.reportingManagerHistory.create({
      data: {
        employeeId: emp.id,
        managerId: null,
        fromDate: joinDate,
        reasonId: 1, // Initial
      },
    });

    console.log(`  [demo] + ${acc.email} (code=${acc.code})`);
  }

  // Second pass: now resolve reportingManagerId from email -> id.
  for (const acc of DEMO_ACCOUNTS) {
    if (!acc.reportsToEmail) continue;
    const mgr = await prisma.employee.findUnique({ where: { email: acc.reportsToEmail } });
    const emp = await prisma.employee.findUnique({ where: { email: acc.email } });
    if (!mgr || !emp || emp.reportingManagerId === mgr.id) continue;
    await prisma.employee.update({
      where: { id: emp.id },
      data: { reportingManagerId: mgr.id },
    });
    await prisma.reportingManagerHistory.updateMany({
      where: { employeeId: emp.id, toDate: null },
      data: { managerId: mgr.id },
    });
  }

  // Third pass: seed LeaveBalance rows for current year × every accrual leave type.
  const year = new Date().getUTCFullYear();
  for (const acc of DEMO_ACCOUNTS) {
    const emp = await prisma.employee.findUnique({ where: { email: acc.email } });
    if (!emp) continue;
    for (const lt of LEAVE_TYPES) {
      if (lt.isEventBased) continue;
      const quota = await prisma.leaveQuota.findUnique({
        where: { leaveTypeId_employmentTypeId: { leaveTypeId: lt.id, employmentTypeId: emp.employmentTypeId } },
      });
      const days = quota?.daysPerYear ?? 0;
      await prisma.leaveBalance.upsert({
        where: { employeeId_leaveTypeId_year: { employeeId: emp.id, leaveTypeId: lt.id, year } },
        create: { employeeId: emp.id, leaveTypeId: lt.id, year, daysRemaining: days, daysUsed: 0 },
        update: {}, // don't clobber existing balance on re-seed
      });
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('Seed: Schema v2');

  console.log('• Configuration');
  await seedConfiguration();

  console.log('• Masters');
  await seedMasterById('role',            ROLES);
  await seedMasterById('employmentType',  EMPLOYMENT_TYPES);
  await seedMasterById('gender',          GENDERS);
  await seedMasterById('auditModule',     AUDIT_MODULES);
  await seedDepartmentsAndDesignations();

  console.log('• Leave types + quotas');
  await seedLeaveTypes();
  await seedLeaveQuotas();

  console.log('• Holidays');
  await seedHolidays(new Date().getUTCFullYear());

  console.log('• Demo accounts');
  await seedDemoAccounts();

  console.log('Seed complete.');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
