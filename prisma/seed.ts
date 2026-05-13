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

import { Prisma, PrismaClient } from '@prisma/client';
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
  'Senior Software Engineer',
  'Engineering Manager',
  'Designer',
  'Senior Designer',
  'Product Manager',
  'Sales Manager',
  'Account Executive',
  'Operations Lead',
  'Head of People',
  'HR Executive',
  'Recruiter',
  'Payroll Officer',
  'Accountant',
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
        status: 1, // Active
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


// ============================================================================
// REALISTIC DATA — replaces the earlier mod-i dummy + expanded-attendance
// blocks with coherent, production-shaped rows so the staging UI feels like
// a real, working org rather than randomly-rotated placeholder values.
//
// Idempotent: marker = presence of employee EMP-2024-0005 (the first
// non-demo realistic employee). If present, the function exits early.
// Otherwise it wipes all dummy-owned tables in FK-safe order (preserves
// masters, configurations, holidays, and the four demo accounts) and
// rebuilds from scratch using the static data tables below.
//
// Determinism: every value is derived from a row index or a fixed table;
// no Math.random anywhere. A fresh DB re-seed produces byte-for-byte
// identical output.
// ============================================================================

import crypto from 'node:crypto';

const REALISTIC_YEAR = 2026;
const REALISTIC_MARKER_CODE = 'EMP-2024-0005';

// ── New employee roster (20 employees beyond the four demos) ─────────────────
//
// Codes EMP-2024-0005..0024. Tree:
//   Priya Sharma (Admin, HR)
//     ├─ Arjun Mehta (Manager, Engineering) — engineering team (5 ICs)
//     ├─ Rohit Khanna (Manager, Design) — 2 designers
//     ├─ Ananya Singh (Manager, Product) — 1 designer
//     ├─ Vikram Joshi (Manager, Sales) — 3 AEs (one Exited)
//     ├─ Ravi Iyer (PayrollOfficer, Finance) — no team
//     └─ Direct reports for support functions:
//         Saanvi (HR), Tara (Recruiter), Manav (Accountant),
//         Neha (Ops, OnNotice), Krishna (Ops), Suresh (HR, Probation)

interface RealisticEmpSeed {
  code: string;
  email: string;
  name: string;
  designationName: string;
  departmentName: string;
  employmentTypeId: 1 | 2 | 3 | 4;
  roleId: 1 | 2 | 3 | 4;
  status: 1 | 2 | 5;
  genderId: 1 | 2 | 3 | 4;
  joinDate: string;
  exitDate?: string;
  phone: string;
  dateOfBirth: string;
  reportsToCode: string | null;
  monthlySalaryPaise: number;
}

const REALISTIC_ROSTER: RealisticEmpSeed[] = [
  // Engineering under Arjun
  { code: 'EMP-2024-0005', email: 'aditya.kumar@triline.co.in',  name: 'Aditya Kumar',   designationName: 'Software Engineer',        departmentName: 'Engineering', employmentTypeId: 1, roleId: 1, status: 1, genderId: 1, joinDate: '2024-01-15', phone: '+91-98201-43251', dateOfBirth: '1996-04-12', reportsToCode: 'EMP-2024-0002', monthlySalaryPaise: 10_00_000 },
  { code: 'EMP-2024-0006', email: 'sneha.patel@triline.co.in',   name: 'Sneha Patel',    designationName: 'Senior Software Engineer', departmentName: 'Engineering', employmentTypeId: 1, roleId: 1, status: 1, genderId: 2, joinDate: '2024-02-10', phone: '+91-98452-71839', dateOfBirth: '1993-08-22', reportsToCode: 'EMP-2024-0002', monthlySalaryPaise: 15_00_000 },
  { code: 'EMP-2024-0007', email: 'karthik.raja@triline.co.in',  name: 'Karthik Raja',   designationName: 'Software Engineer',        departmentName: 'Engineering', employmentTypeId: 1, roleId: 1, status: 1, genderId: 1, joinDate: '2024-04-05', phone: '+91-97401-92847', dateOfBirth: '1997-11-30', reportsToCode: 'EMP-2024-0002', monthlySalaryPaise: 9_50_000 },
  { code: 'EMP-2024-0008', email: 'pooja.bansal@triline.co.in',  name: 'Pooja Bansal',   designationName: 'Software Engineer',        departmentName: 'Engineering', employmentTypeId: 3, roleId: 1, status: 1, genderId: 2, joinDate: '2026-01-15', phone: '+91-99201-44732', dateOfBirth: '1999-06-15', reportsToCode: 'EMP-2024-0002', monthlySalaryPaise: 6_50_000 },
  { code: 'EMP-2024-0009', email: 'vikrant.jain@triline.co.in',  name: 'Vikrant Jain',   designationName: 'Software Engineer',        departmentName: 'Engineering', employmentTypeId: 4, roleId: 1, status: 1, genderId: 1, joinDate: '2026-03-15', phone: '+91-98712-39482', dateOfBirth: '2002-01-20', reportsToCode: 'EMP-2024-0002', monthlySalaryPaise: 2_50_000 },
  // Design under Rohit
  { code: 'EMP-2024-0010', email: 'rohit.khanna@triline.co.in',  name: 'Rohit Khanna',   designationName: 'Senior Designer',          departmentName: 'Design',      employmentTypeId: 1, roleId: 2, status: 1, genderId: 1, joinDate: '2023-04-10', phone: '+91-99720-58194', dateOfBirth: '1989-09-18', reportsToCode: 'EMP-2024-0001', monthlySalaryPaise: 18_00_000 },
  { code: 'EMP-2024-0011', email: 'aanya.iyer@triline.co.in',    name: 'Aanya Iyer',     designationName: 'Designer',                 departmentName: 'Design',      employmentTypeId: 1, roleId: 1, status: 1, genderId: 2, joinDate: '2024-10-01', phone: '+91-99873-21940', dateOfBirth: '1995-02-08', reportsToCode: 'EMP-2024-0010', monthlySalaryPaise: 8_50_000 },
  { code: 'EMP-2024-0012', email: 'diya.nair@triline.co.in',     name: 'Diya Nair',      designationName: 'Designer',                 departmentName: 'Design',      employmentTypeId: 2, roleId: 1, status: 1, genderId: 2, joinDate: '2024-11-05', phone: '+91-94462-71035', dateOfBirth: '1994-12-03', reportsToCode: 'EMP-2024-0010', monthlySalaryPaise: 11_00_000 },
  // Product under Ananya
  { code: 'EMP-2024-0013', email: 'ananya.singh@triline.co.in',  name: 'Ananya Singh',   designationName: 'Product Manager',          departmentName: 'Product',     employmentTypeId: 1, roleId: 2, status: 1, genderId: 2, joinDate: '2023-08-15', phone: '+91-99809-47231', dateOfBirth: '1991-05-25', reportsToCode: 'EMP-2024-0001', monthlySalaryPaise: 18_00_000 },
  // Sales under Vikram
  { code: 'EMP-2024-0014', email: 'vikram.joshi@triline.co.in',  name: 'Vikram Joshi',   designationName: 'Sales Manager',            departmentName: 'Sales',       employmentTypeId: 1, roleId: 2, status: 1, genderId: 1, joinDate: '2023-11-01', phone: '+91-98870-21405', dateOfBirth: '1988-07-14', reportsToCode: 'EMP-2024-0001', monthlySalaryPaise: 16_50_000 },
  { code: 'EMP-2024-0015', email: 'tanvi.shah@triline.co.in',    name: 'Tanvi Shah',     designationName: 'Account Executive',        departmentName: 'Sales',       employmentTypeId: 1, roleId: 1, status: 1, genderId: 2, joinDate: '2024-05-20', phone: '+91-98330-58194', dateOfBirth: '1996-03-19', reportsToCode: 'EMP-2024-0014', monthlySalaryPaise: 7_50_000 },
  { code: 'EMP-2024-0016', email: 'aryan.gupta@triline.co.in',   name: 'Aryan Gupta',    designationName: 'Account Executive',        departmentName: 'Sales',       employmentTypeId: 1, roleId: 1, status: 1, genderId: 1, joinDate: '2024-06-15', phone: '+91-99762-30418', dateOfBirth: '1995-10-08', reportsToCode: 'EMP-2024-0014', monthlySalaryPaise: 7_50_000 },
  { code: 'EMP-2024-0017', email: 'riya.malhotra@triline.co.in', name: 'Riya Malhotra',  designationName: 'Account Executive',        departmentName: 'Sales',       employmentTypeId: 1, roleId: 1, status: 5, genderId: 2, joinDate: '2023-12-01', exitDate: '2026-04-30', phone: '+91-98765-43210', dateOfBirth: '1994-08-11', reportsToCode: 'EMP-2024-0014', monthlySalaryPaise: 7_50_000 },
  // Support functions
  { code: 'EMP-2024-0018', email: 'saanvi.joshi@triline.co.in',  name: 'Saanvi Joshi',   designationName: 'HR Executive',             departmentName: 'HR',          employmentTypeId: 1, roleId: 1, status: 1, genderId: 2, joinDate: '2024-07-01', phone: '+91-99820-47301', dateOfBirth: '1993-04-29', reportsToCode: 'EMP-2024-0001', monthlySalaryPaise: 6_00_000 },
  { code: 'EMP-2024-0019', email: 'tara.gupta@triline.co.in',    name: 'Tara Gupta',     designationName: 'Recruiter',                departmentName: 'HR',          employmentTypeId: 1, roleId: 1, status: 1, genderId: 2, joinDate: '2024-09-15', phone: '+91-99432-71059', dateOfBirth: '1994-11-12', reportsToCode: 'EMP-2024-0001', monthlySalaryPaise: 6_50_000 },
  { code: 'EMP-2024-0020', email: 'manav.pillai@triline.co.in',  name: 'Manav Pillai',   designationName: 'Accountant',               departmentName: 'Finance',     employmentTypeId: 1, roleId: 1, status: 1, genderId: 1, joinDate: '2024-08-10', phone: '+91-99201-83472', dateOfBirth: '1992-01-23', reportsToCode: 'EMP-2024-0001', monthlySalaryPaise: 7_00_000 },
  { code: 'EMP-2024-0021', email: 'neha.kapoor@triline.co.in',   name: 'Neha Kapoor',    designationName: 'Operations Lead',          departmentName: 'Operations',  employmentTypeId: 1, roleId: 1, status: 2, genderId: 2, joinDate: '2023-05-15', phone: '+91-98301-58294', dateOfBirth: '1990-09-08', reportsToCode: 'EMP-2024-0001', monthlySalaryPaise: 9_00_000 },
  { code: 'EMP-2024-0022', email: 'krishna.patel@triline.co.in', name: 'Krishna Patel',  designationName: 'Operations Lead',          departmentName: 'Operations',  employmentTypeId: 1, roleId: 1, status: 1, genderId: 1, joinDate: '2025-04-10', phone: '+91-99431-20581', dateOfBirth: '1991-12-15', reportsToCode: 'EMP-2024-0001', monthlySalaryPaise: 9_00_000 },
  { code: 'EMP-2024-0023', email: 'suresh.bhatia@triline.co.in', name: 'Suresh Bhatia',  designationName: 'HR Executive',             departmentName: 'HR',          employmentTypeId: 3, roleId: 1, status: 1, genderId: 1, joinDate: '2026-02-20', phone: '+91-98270-31049', dateOfBirth: '1996-06-04', reportsToCode: 'EMP-2024-0001', monthlySalaryPaise: 5_00_000 },
  { code: 'EMP-2024-0024', email: 'mira.desai@triline.co.in',    name: 'Mira Desai',     designationName: 'Designer',                 departmentName: 'Product',     employmentTypeId: 2, roleId: 1, status: 1, genderId: 2, joinDate: '2024-12-10', phone: '+91-99752-13049', dateOfBirth: '1995-07-21', reportsToCode: 'EMP-2024-0013', monthlySalaryPaise: 10_50_000 },
];

const DEMO_MONTHLY_SALARY_PAISE: Record<string, number> = {
  'EMP-2024-0001': 21_00_000, // Priya
  'EMP-2024-0002': 20_00_000, // Arjun
  'EMP-2024-0003': 10_00_000, // Kavya
  'EMP-2024-0004': 10_00_000, // Ravi
};

const LEAVE_REASONS = [
  "Sister's wedding in Jaipur",
  'Annual medical checkup at Apollo Hospital',
  "Diwali holidays at parents' place",
  'Family function in Mumbai',
  'Visiting elderly grandparents in Lucknow',
  'Trekking trip to Manali',
  "Brother's engagement ceremony",
  'Personal health break — recovering from migraine',
  'Sick — viral fever, doctor advised rest',
  'Pongal celebrations with family',
  'Holi celebrations at home',
  "Cousin's wedding in Hyderabad",
  "Friend's destination wedding in Goa",
  'New Year vacation in Kerala',
  'Knee surgery follow-up appointment',
  'Family emergency — father admitted to hospital',
  'Onam celebrations with parents in Kochi',
  "Daughter's school annual day",
  "Brother's wedding in Bengaluru",
  'Personal time off — moving to a new apartment',
];

const REJECTION_NOTES = [
  'Resource conflict — please reapply for adjacent weeks.',
  'Critical project deliverable that week; please discuss with manager.',
  'Multiple team members already on leave that period.',
  'Insufficient notice — minimum 7 working days required for this duration.',
];

const APPROVAL_NOTES = [
  'Approved — enjoy the time off!',
  'Approved. Please ensure handover notes are in place before leaving.',
  'Approved. Hope you feel better soon.',
  'Approved. Let me know if you need any team coverage.',
  'Approved.',
];

// ── Helpers ────────────────────────────────────────────────────────────────

function dt(s: string): Date {
  return s.length === 10 ? new Date(`${s}T00:00:00Z`) : new Date(s);
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function splitSalary(monthly: number): {
  basicPaise: number;
  allowancesPaise: number;
  hraPaise: number;
  transportPaise: number;
  otherPaise: number;
} {
  const basic = Math.round(monthly * 0.6);
  const allowances = monthly - basic;
  const hra = Math.round(monthly * 0.25);
  const transport = Math.round(monthly * 0.05);
  const other = allowances - hra - transport;
  return { basicPaise: basic, allowancesPaise: allowances, hraPaise: hra, transportPaise: transport, otherPaise: other };
}

// ── Wipe (FK-safe order) ──────────────────────────────────────────────────

async function wipeDummyOwnedTables(): Promise<void> {
  await prisma.goal.deleteMany({});
  await prisma.performanceReview.deleteMany({});
  await prisma.performanceCycle.deleteMany({});
  await prisma.payslip.deleteMany({});
  await prisma.payrollRun.deleteMany({});
  await prisma.leaveEncashment.deleteMany({});
  await prisma.attendanceRecord.deleteMany({});
  await prisma.regularisationRequest.deleteMany({});
  await prisma.attendanceLateLedger.deleteMany({});
  await prisma.leaveBalanceLedger.deleteMany({});
  await prisma.leaveRequest.deleteMany({});
  await prisma.leaveBalance.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.idempotencyKey.deleteMany({});
  await prisma.passwordResetToken.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await prisma.reportingManagerHistory.deleteMany({});
  await prisma.salaryStructure.deleteMany({});
  await prisma.employee.deleteMany({ where: { id: { gt: 4 } } });
  await prisma.leaveCodeCounter.deleteMany({});
  await prisma.regCodeCounter.deleteMany({});
  await prisma.encashmentCodeCounter.deleteMany({});
  await prisma.payrollCodeCounter.deleteMany({});
}

// ── Realistic seed entry point ───────────────────────────────────────────

async function seedRealisticData(): Promise<void> {
  const marker = await prisma.employee.findUnique({
    where: { code: REALISTIC_MARKER_CODE },
    select: { id: true },
  });
  if (marker) {
    console.log('  [realistic] already seeded, skipping');
    return;
  }

  console.log('  [realistic] wiping dummy-owned tables…');
  await wipeDummyOwnedTables();

  // ── Resolve demo accounts (preserved by the wipe) ────────────────────────
  const demos = await prisma.employee.findMany({
    where: { id: { lte: 4 } },
    select: { id: true, code: true, email: true, joinDate: true, employmentTypeId: true, reportingManagerId: true },
  });
  const byCode = new Map(demos.map((e) => [e.code, e]));
  const adminEmp = byCode.get('EMP-2024-0001')!;
  const mgrEmp = byCode.get('EMP-2024-0002')!;
  const empEmp = byCode.get('EMP-2024-0003')!;
  const payEmp = byCode.get('EMP-2024-0004')!;

  // Master lookups
  const depts = await prisma.department.findMany({ select: { id: true, name: true } });
  const desigs = await prisma.designation.findMany({ select: { id: true, name: true } });
  const deptId = new Map(depts.map((d) => [d.name, d.id]));
  const desigId = new Map(desigs.map((d) => [d.name, d.id]));

  // ── Create 20 new employees ──────────────────────────────────────────────
  console.log('  [realistic] creating 20 employees…');
  const sharedHash = await argon2.hash('admin@123', { type: argon2.argon2id });

  type NewEmpRow = RealisticEmpSeed & { id: number; reportingManagerId: number | null };
  const newEmps: NewEmpRow[] = [];
  for (const r of REALISTIC_ROSTER) {
    const emp = await prisma.employee.create({
      data: {
        code: r.code,
        email: r.email,
        name: r.name,
        passwordHash: sharedHash,
        roleId: r.roleId,
        employmentTypeId: r.employmentTypeId,
        departmentId: deptId.get(r.departmentName) ?? null,
        designationId: desigId.get(r.designationName) ?? null,
        genderId: r.genderId,
        status: r.status,
        phone: r.phone,
        dateOfBirth: dt(r.dateOfBirth),
        joinDate: dt(r.joinDate),
        exitDate: r.exitDate ? dt(r.exitDate) : null,
        mustResetPassword: false,
        version: 0,
      },
    });
    newEmps.push({ ...r, id: emp.id, reportingManagerId: null });
  }

  // Resolve reporting hierarchy
  const codeToId = new Map<string, number>([
    ...demos.map((d) => [d.code, d.id] as const),
    ...newEmps.map((e) => [e.code, e.id] as const),
  ]);
  for (const r of newEmps) {
    if (!r.reportsToCode) continue;
    const managerId = codeToId.get(r.reportsToCode);
    if (!managerId) continue;
    if (r.status === 5) {
      await prisma.employee.update({
        where: { id: r.id },
        data: { reportingManagerId: null, previousReportingManagerId: managerId },
      });
    } else {
      await prisma.employee.update({
        where: { id: r.id },
        data: { reportingManagerId: managerId },
      });
      r.reportingManagerId = managerId;
    }
  }

  // Re-fetch all employees with resolved hierarchy
  const allEmps = await prisma.employee.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true, code: true, email: true, name: true,
      roleId: true, employmentTypeId: true, departmentId: true, designationId: true,
      reportingManagerId: true, status: true, joinDate: true, exitDate: true,
    },
  });

  // ── Salary structures ────────────────────────────────────────────────────
  console.log('  [realistic] writing salary structures…');
  const salaryRows: Prisma.SalaryStructureCreateManyInput[] = allEmps.map((e) => {
    const r = REALISTIC_ROSTER.find((x) => x.code === e.code);
    const monthly = r?.monthlySalaryPaise ?? DEMO_MONTHLY_SALARY_PAISE[e.code] ?? 10_00_000;
    const split = splitSalary(monthly);
    return {
      employeeId: e.id,
      basicPaise: split.basicPaise,
      allowancesPaise: split.allowancesPaise,
      hraPaise: split.hraPaise,
      transportPaise: split.transportPaise,
      otherPaise: split.otherPaise,
      daPaise: null,
      effectiveFrom: dt('2024-01-01'),
      version: 0,
    };
  });
  await prisma.salaryStructure.createMany({ data: salaryRows });

  // ── Reporting manager history ────────────────────────────────────────────
  console.log('  [realistic] writing reporting-manager history…');
  const rmHistoryRows: Prisma.ReportingManagerHistoryCreateManyInput[] = [];
  for (const e of allEmps) {
    rmHistoryRows.push({
      employeeId: e.id,
      managerId: e.reportingManagerId,
      fromDate: e.joinDate,
      toDate: e.exitDate ?? null,
      reasonId: 1, // Initial
    });
    if (e.status === 5 && e.exitDate) {
      rmHistoryRows.push({
        employeeId: e.id,
        managerId: null,
        fromDate: e.exitDate,
        toDate: null,
        reasonId: 3, // Exited
      });
    }
  }
  await prisma.reportingManagerHistory.createMany({ data: rmHistoryRows });

  // ── Leave balances (4 accrual types × every employee) ────────────────────
  console.log('  [realistic] writing leave balances…');
  const ACCRUAL_TYPES = [1, 2, 3, 4]; // Annual, Sick, Casual, Unpaid
  const balanceRows: Prisma.LeaveBalanceCreateManyInput[] = [];
  for (const e of allEmps) {
    for (const lt of ACCRUAL_TYPES) {
      const quota = await prisma.leaveQuota.findUnique({
        where: { leaveTypeId_employmentTypeId: { leaveTypeId: lt, employmentTypeId: e.employmentTypeId } },
      });
      const total = quota?.daysPerYear ?? 0;
      balanceRows.push({
        employeeId: e.id,
        leaveTypeId: lt,
        year: REALISTIC_YEAR,
        daysRemaining: total,
        daysUsed: 0,
        daysEncashed: 0,
        version: 0,
      });
    }
  }
  await prisma.leaveBalance.createMany({ data: balanceRows });

  // ── Leave requests (30) + ledger + balance deductions ────────────────────
  console.log('  [realistic] writing leave requests + ledger…');
  type LR = [string, number, string, string, 1 | 2 | 3 | 4 | 5, number];
  const leaveSeeds: LR[] = [
    ['EMP-2024-0003', 1, '2025-11-10', '2025-11-12', 2, 0],
    ['EMP-2024-0005', 1, '2025-11-17', '2025-11-19', 2, 2],
    ['EMP-2024-0006', 2, '2025-12-04', '2025-12-04', 2, 8],
    ['EMP-2024-0007', 1, '2025-12-22', '2025-12-26', 2, 13],
    ['EMP-2024-0011', 1, '2025-12-29', '2026-01-02', 2, 13],
    ['EMP-2024-0015', 1, '2026-01-13', '2026-01-15', 2, 9],
    ['EMP-2024-0017', 2, '2026-01-20', '2026-01-21', 2, 8],
    ['EMP-2024-0019', 3, '2026-01-29', '2026-01-30', 2, 17],
    ['EMP-2024-0020', 1, '2026-02-09', '2026-02-13', 2, 11],
    ['EMP-2024-0008', 2, '2026-02-16', '2026-02-17', 2, 8],
    ['EMP-2024-0010', 1, '2026-03-02', '2026-03-04', 2, 10],
    ['EMP-2024-0016', 1, '2026-03-09', '2026-03-13', 3, 12],
    ['EMP-2024-0013', 1, '2026-03-23', '2026-03-25', 2, 3],
    ['EMP-2024-0005', 3, '2026-04-06', '2026-04-07', 2, 17],
    ['EMP-2024-0012', 1, '2026-04-13', '2026-04-17', 2, 19],
    ['EMP-2024-0006', 1, '2026-04-20', '2026-04-22', 4, 5],
    ['EMP-2024-0014', 1, '2026-04-27', '2026-04-30', 2, 4],
    ['EMP-2024-0003', 2, '2026-05-04', '2026-05-05', 2, 8],
    ['EMP-2024-0007', 1, '2026-05-08', '2026-05-08', 2, 17],
    ['EMP-2024-0020', 3, '2026-05-11', '2026-05-11', 2, 17],
    ['EMP-2024-0018', 1, '2026-05-14', '2026-05-15', 1, 18],
    ['EMP-2024-0011', 2, '2026-05-15', '2026-05-15', 1, 7],
    ['EMP-2024-0015', 1, '2026-05-18', '2026-05-22', 1, 3],
    ['EMP-2024-0022', 1, '2026-05-25', '2026-05-29', 1, 6],
    ['EMP-2024-0010', 1, '2026-05-26', '2026-05-27', 1, 0],
    ['EMP-2024-0007', 1, '2026-04-20', '2026-04-24', 5, 4],
    ['EMP-2024-0014', 1, '2026-04-13', '2026-04-15', 5, 15],
    ['EMP-2024-0016', 3, '2026-05-04', '2026-05-04', 3, 7],
    ['EMP-2024-0009', 3, '2026-04-27', '2026-04-27', 4, 17],
    ['EMP-2024-0024', 1, '2026-05-04', '2026-05-08', 3, 12],
  ];

  let lCounter = 0;
  for (const [empCode, leaveTypeId, fromStr, toStr, status, reasonIdx] of leaveSeeds) {
    lCounter++;
    const emp = allEmps.find((e) => e.code === empCode);
    if (!emp) continue;
    const managerId = emp.reportingManagerId ?? adminEmp.id;
    const fromDate = dt(fromStr);
    const toDate = dt(toStr);
    const days = daysBetween(fromDate, toDate);

    const eventBased = leaveTypeId === 5 || leaveTypeId === 6;
    const routedToId: 1 | 2 = eventBased || managerId === adminEmp.id ? 2 : 1;
    const approverId = routedToId === 1 ? managerId : adminEmp.id;
    const decided = status === 2 || status === 3 || status === 4;
    const submittedAt = addDays(fromDate, -7);
    const decidedAt = decided ? addDays(submittedAt, 2) : null;

    const decisionNote =
      status === 2 ? APPROVAL_NOTES[lCounter % APPROVAL_NOTES.length]!
      : status === 3 ? REJECTION_NOTES[lCounter % REJECTION_NOTES.length]!
      : null;

    const deductedDays = status === 2 ? days : 0;
    const restoredDays = status === 4 ? days : 0;

    const code = `L-${REALISTIC_YEAR}-${String(lCounter).padStart(4, '0')}`;

    const created = await prisma.leaveRequest.create({
      data: {
        code,
        employeeId: emp.id,
        leaveTypeId,
        fromDate,
        toDate,
        days,
        reason: LEAVE_REASONS[reasonIdx] ?? LEAVE_REASONS[0]!,
        status,
        routedToId,
        approverId: status === 4 && !decidedAt ? null : approverId,
        decidedAt,
        decidedBy: decided ? approverId : null,
        decisionNote,
        escalatedAt: status === 5 ? addDays(submittedAt, 5) : null,
        cancelledAt: status === 4 ? addDays(submittedAt, 3) : null,
        cancelledBy: status === 4 ? emp.id : null,
        cancelledAfterStart: false,
        deductedDays,
        restoredDays,
        createdAt: submittedAt,
        updatedAt: decidedAt ?? submittedAt,
        version: 0,
      },
    });

    if (status === 2) {
      await prisma.leaveBalanceLedger.create({
        data: {
          employeeId: emp.id,
          leaveTypeId,
          year: REALISTIC_YEAR,
          delta: -days,
          reasonId: 2, // Approval
          relatedRequestId: created.id,
          createdBy: approverId,
          createdAt: decidedAt!,
        },
      });
      await prisma.leaveBalance.updateMany({
        where: { employeeId: emp.id, leaveTypeId, year: REALISTIC_YEAR },
        data: {
          daysRemaining: { decrement: days },
          daysUsed: { increment: days },
        },
      });
    }
  }

  // Initial allocation ledger entries (post-deductions snapshot)
  const initialLedgerRows: Prisma.LeaveBalanceLedgerCreateManyInput[] = [];
  for (const e of allEmps) {
    for (const lt of ACCRUAL_TYPES) {
      const bal = await prisma.leaveBalance.findUnique({
        where: { employeeId_leaveTypeId_year: { employeeId: e.id, leaveTypeId: lt, year: REALISTIC_YEAR } },
      });
      if (!bal) continue;
      initialLedgerRows.push({
        employeeId: e.id,
        leaveTypeId: lt,
        year: REALISTIC_YEAR,
        delta: bal.daysRemaining + bal.daysUsed,
        reasonId: 1, // Initial
        relatedRequestId: null,
        createdBy: null,
        createdAt: dt('2026-01-01'),
      });
    }
  }
  await prisma.leaveBalanceLedger.createMany({ data: initialLedgerRows });

  // ── Attendance — Apr 1 to May 13, skip approved-leave dates ─────────────
  console.log('  [realistic] writing attendance records…');
  const FROM = dt('2026-04-01');
  const TO = dt('2026-05-13');
  const holidays = await prisma.holiday.findMany({ select: { date: true } });
  const holidayKeys = new Set(holidays.map((h) => h.date.toISOString().slice(0, 10)));

  const approvedLeaves = await prisma.leaveRequest.findMany({
    where: { status: 2 },
    select: { employeeId: true, fromDate: true, toDate: true },
  });
  const onLeaveKeys = new Set<string>();
  for (const l of approvedLeaves) {
    for (let d = new Date(l.fromDate); d <= l.toDate; d = addDays(d, 1)) {
      onLeaveKeys.add(`${l.employeeId}|${d.toISOString().slice(0, 10)}`);
    }
  }

  const attRows: Prisma.AttendanceRecordCreateManyInput[] = [];
  let cellIdx = 0;
  for (let d = new Date(FROM); d <= TO; d = addDays(d, 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const key = d.toISOString().slice(0, 10);
    if (holidayKeys.has(key)) continue;
    for (const e of allEmps) {
      if (d < e.joinDate) continue;
      if (e.exitDate && d > e.exitDate) continue;
      if (e.status === 5) continue;

      cellIdx++;
      const empLeaveKey = `${e.id}|${key}`;
      let status: number;
      let late = false;
      let checkIn: Date | null = null;
      let checkOut: Date | null = null;
      let hours: number | null = null;

      if (onLeaveKeys.has(empLeaveKey)) {
        status = 3; // OnLeave
      } else {
        const slot = cellIdx % 100;
        if (slot < 3) {
          status = 2; // Absent
        } else {
          status = 1; // Present
          late = slot >= 95; // ~5% late
          const lateMin = late ? 45 : 0;
          const dayBase = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
          checkIn = new Date(dayBase.getTime() + (3 * 60 + 30 + lateMin) * 60_000);
          checkOut = new Date(dayBase.getTime() + (12 * 60 + 30) * 60_000);
          hours = 540 - lateMin;
        }
      }

      attRows.push({
        employeeId: e.id,
        date: new Date(d.getTime()),
        status,
        checkInTime: checkIn,
        checkOutTime: checkOut,
        hoursWorkedMinutes: hours,
        late,
        lateMonthCount: 0,
        lopApplied: status === 2,
        sourceId: 1,
      });
    }
  }
  await prisma.attendanceRecord.createMany({ data: attRows });

  // Attendance late ledger (derived from attendance rows)
  console.log('  [realistic] writing attendance late ledger…');
  const lateByEmpMonth = new Map<string, number>();
  for (const a of attRows) {
    if (!a.late) continue;
    const adate = a.date as Date;
    const m = adate.getUTCMonth() + 1;
    const y = adate.getUTCFullYear();
    const key = `${a.employeeId}|${y}|${m}`;
    lateByEmpMonth.set(key, (lateByEmpMonth.get(key) ?? 0) + 1);
  }
  const lateLedgerRows: Prisma.AttendanceLateLedgerCreateManyInput[] = [];
  for (const [key, count] of lateByEmpMonth.entries()) {
    const [empIdStr, yStr, mStr] = key.split('|');
    lateLedgerRows.push({
      employeeId: Number(empIdStr),
      year: Number(yStr),
      month: Number(mStr),
      count,
    });
  }
  if (lateLedgerRows.length) {
    await prisma.attendanceLateLedger.createMany({ data: lateLedgerRows });
  }

  // ── Regularisations (12) ─────────────────────────────────────────────────
  console.log('  [realistic] writing regularisations…');
  type RR = [string, string, 1 | 2 | 3, number];
  const REG_REASONS = [
    'VPN was down on our segment — submitted by 9:30 over LTE but punch failed.',
    'Client call ran past 6 PM, forgot to punch out before leaving for the day.',
    'Came in via the side entrance — biometric reader was offline.',
    'Was on a customer site visit; missed the in-office check-in.',
    'Internet outage at home affected the WFH check-in.',
    'Punched in early at 8:45 but the system shows no record — see CCTV if needed.',
    'Power outage in the office at 9 AM, punched in once UPS kicked in.',
    'Forgot phone at home; punched out manually from my desktop later.',
  ];
  const regSeeds: RR[] = [
    ['EMP-2024-0003', '2026-04-21', 2, 0],
    ['EMP-2024-0005', '2026-04-23', 2, 1],
    ['EMP-2024-0006', '2026-04-28', 2, 2],
    ['EMP-2024-0007', '2026-05-04', 2, 3],
    ['EMP-2024-0011', '2026-05-06', 2, 4],
    ['EMP-2024-0015', '2026-05-07', 2, 5],
    ['EMP-2024-0010', '2026-04-08', 2, 6],
    ['EMP-2024-0013', '2026-05-08', 1, 7],
    ['EMP-2024-0019', '2026-05-11', 1, 0],
    ['EMP-2024-0020', '2026-05-12', 1, 1],
    ['EMP-2024-0008', '2026-05-05', 3, 6],
    ['EMP-2024-0016', '2026-04-30', 3, 2],
  ];

  for (let i = 0; i < regSeeds.length; i++) {
    const [empCode, dateStr, status, reasonIdx] = regSeeds[i]!;
    const emp = allEmps.find((e) => e.code === empCode)!;
    const managerId = emp.reportingManagerId ?? adminEmp.id;
    const regDate = dt(dateStr);
    const submitAt = addDays(regDate, 1);
    const ageDays = Math.max(1, Math.round((submitAt.getTime() - regDate.getTime()) / 86_400_000));
    const routedToId: 1 | 2 = ageDays > 7 ? 2 : 1;
    const approverId = routedToId === 1 ? managerId : adminEmp.id;
    const decided = status === 2 || status === 3;
    const decidedAt = decided ? addDays(submitAt, 2) : null;

    await prisma.regularisationRequest.create({
      data: {
        code: `R-${REALISTIC_YEAR}-${String(i + 1).padStart(4, '0')}`,
        employeeId: emp.id,
        date: regDate,
        proposedCheckIn: new Date(regDate.getTime() + (3 * 60 + 30) * 60_000),
        proposedCheckOut: new Date(regDate.getTime() + (12 * 60 + 30) * 60_000),
        reason: REG_REASONS[reasonIdx] ?? REG_REASONS[0]!,
        status,
        routedToId,
        ageDaysAtSubmit: ageDays,
        approverId: status === 1 ? approverId : (decided ? approverId : null),
        decidedAt,
        decidedBy: decided ? approverId : null,
        decisionNote: status === 3 ? 'Insufficient evidence — please raise within 7 days next time.' : null,
        correctedRecordId: null,
        version: 0,
        createdAt: submitAt,
        updatedAt: decidedAt ?? submitAt,
      },
    });
  }

  // ── Leave encashments (6, Dec 2025 window) ───────────────────────────────
  console.log('  [realistic] writing leave encashments…');
  type LE = [string, number, 1 | 2 | 3 | 4 | 5 | 6];
  const encSeeds: LE[] = [
    ['EMP-2024-0003', 4, 4],
    ['EMP-2024-0005', 3, 4],
    ['EMP-2024-0006', 5, 4],
    ['EMP-2024-0010', 6, 3],
    ['EMP-2024-0015', 4, 5],
    ['EMP-2024-0011', 3, 6],
  ];
  for (let i = 0; i < encSeeds.length; i++) {
    const [empCode, daysReq, status] = encSeeds[i]!;
    const emp = allEmps.find((e) => e.code === empCode)!;
    const managerId = emp.reportingManagerId ?? adminEmp.id;
    const routedToId: 1 | 2 = status === 1 ? 1 : 2;
    const approverId = status === 1 ? managerId : adminEmp.id;
    const decided = status !== 1;
    const submitAt = dt('2025-12-10');
    const decidedAt = decided ? dt('2025-12-15') : null;
    const daysApp = status >= 3 && status <= 4 ? daysReq : null;
    const rate = daysApp ? 200_000 : null;
    await prisma.leaveEncashment.create({
      data: {
        code: `LE-2025-${String(i + 1).padStart(4, '0')}`,
        employeeId: emp.id,
        year: 2025,
        daysRequested: daysReq,
        daysApproved: daysApp,
        ratePerDayPaise: rate,
        amountPaise: daysApp && rate ? daysApp * rate : null,
        status,
        routedToId,
        approverId: decided ? approverId : managerId,
        decidedAt,
        decidedBy: decided ? approverId : null,
        decisionNote: status === 5 ? 'Insufficient remaining balance after Dec payroll deductions.' : null,
        escalatedAt: null,
        paidAt: status === 4 ? dt('2025-12-31') : null,
        cancelledAt: status === 6 ? dt('2025-12-20') : null,
        cancelledBy: status === 6 ? emp.id : null,
        version: 0,
        createdAt: submitAt,
        updatedAt: decidedAt ?? submitAt,
      },
    });
  }

  // ── Payroll runs + payslips (Jan–May 2026) ───────────────────────────────
  console.log('  [realistic] writing payroll runs + payslips…');
  const runMonths = [1, 2, 3, 4, 5];
  for (const m of runMonths) {
    const finalised = m <= 4;
    const periodStart = new Date(Date.UTC(REALISTIC_YEAR, m - 1, 1));
    const periodEnd = new Date(Date.UTC(REALISTIC_YEAR, m, 0));
    const run = await prisma.payrollRun.create({
      data: {
        code: `RUN-${REALISTIC_YEAR}-${String(m).padStart(2, '0')}`,
        month: m,
        year: REALISTIC_YEAR,
        status: finalised ? 3 : 2,
        workingDays: 22,
        periodStart,
        periodEnd,
        initiatedBy: payEmp.id,
        initiatedAt: new Date(periodEnd.getTime() - 86_400_000),
        finalisedBy: finalised ? adminEmp.id : null,
        finalisedAt: finalised ? new Date(periodEnd.getTime() + 86_400_000) : null,
      },
    });

    let payslipSeq = 0;
    for (const e of allEmps) {
      if (e.joinDate > periodEnd) continue;
      if (e.exitDate && e.exitDate < periodStart) continue;

      const salary = await prisma.salaryStructure.findFirst({
        where: { employeeId: e.id },
        orderBy: { effectiveFrom: 'desc' },
      });
      if (!salary) continue;

      const lopCount = await prisma.attendanceRecord.count({
        where: {
          employeeId: e.id,
          date: { gte: periodStart, lte: periodEnd },
          status: 2,
          lopApplied: true,
        },
      });
      const workingDays = 22;
      const basic = salary.basicPaise;
      const allow = salary.allowancesPaise;
      const monthlyTotal = basic + allow;
      const lopDeduction = lopCount > 0 ? Math.round((monthlyTotal / workingDays) * lopCount) : 0;
      const daysWorked = workingDays - lopCount;
      const gross = monthlyTotal - lopDeduction;
      const tax = Math.round(gross * 0.095);
      const otherDeductions = Math.round(monthlyTotal * 0.02);
      const net = gross - tax - otherDeductions;

      payslipSeq++;
      await prisma.payslip.create({
        data: {
          code: `P-${REALISTIC_YEAR}-${String(m).padStart(2, '0')}-${String(payslipSeq).padStart(4, '0')}`,
          runId: run.id,
          employeeId: e.id,
          month: m,
          year: REALISTIC_YEAR,
          status: finalised ? 3 : 2,
          periodStart,
          periodEnd,
          workingDays,
          daysWorked,
          lopDays: lopCount,
          basicPaise: basic,
          allowancesPaise: allow,
          grossPaise: gross,
          lopDeductionPaise: lopDeduction,
          referenceTaxPaise: tax,
          finalTaxPaise: tax,
          otherDeductionsPaise: otherDeductions,
          netPayPaise: net,
          finalisedAt: finalised ? run.finalisedAt : null,
        },
      });
    }
  }

  // ── Performance cycles + reviews + goals ─────────────────────────────────
  console.log('  [realistic] writing performance cycles, reviews, goals…');
  const closedCycle = await prisma.performanceCycle.create({
    data: {
      code: 'C-2025-H2',
      fyStart: dt('2025-10-01'),
      fyEnd: dt('2026-03-31'),
      status: 4,
      selfReviewDeadline: dt('2026-02-15'),
      managerReviewDeadline: dt('2026-03-01'),
      closedAt: dt('2026-03-05T00:00:00Z'),
      closedBy: adminEmp.id,
      createdBy: adminEmp.id,
      createdAt: dt('2025-10-01'),
    },
  });
  const openCycle = await prisma.performanceCycle.create({
    data: {
      code: 'C-2026-H1',
      fyStart: dt('2026-04-01'),
      fyEnd: dt('2026-09-30'),
      status: 1,
      selfReviewDeadline: dt('2026-08-15'),
      managerReviewDeadline: dt('2026-09-01'),
      createdBy: adminEmp.id,
      createdAt: dt('2026-04-01'),
    },
  });

  const GOAL_TEMPLATES = [
    'Ship the v2 frontend rewrite for the assigned module.',
    'Reduce p95 API latency on the relevant endpoint by 30%.',
    'Mentor at least one junior engineer through a complete feature delivery.',
    'Close all P1 bugs reported in the previous cycle.',
    'Publish a design system component pattern adopted by the team.',
    'Lead the discovery for one major customer-facing initiative.',
    'Close 8 enterprise deals worth ₹2 Cr+ ARR each.',
    'Run two onsite client workshops in the assigned region.',
    'Onboard 3 new hires through a structured 30-day plan.',
    'Reduce monthly payroll-run reconciliation time from 4 hrs to 30 min.',
    'Drive the SOC 2 Type I audit prep to completion.',
    'Establish a quarterly hiring cadence with the recruiting team.',
    'Achieve <5% missed deliverables across goals set this cycle.',
    'Increase self-served onboarding completion rate to 80%.',
    'Reduce average ticket resolution time by 25%.',
  ];

  const closedEligible = allEmps.filter((e) => e.joinDate <= dt('2025-10-01'));
  for (let i = 0; i < closedEligible.length; i++) {
    const e = closedEligible[i]!;
    const managerId = e.reportingManagerId ?? adminEmp.id;
    const selfR = 3 + (i % 3);
    const mgrR = Math.min(5, Math.max(2, selfR + ((i % 3) - 1)));
    const review = await prisma.performanceReview.create({
      data: {
        cycleId: closedCycle.id,
        employeeId: e.id,
        managerId,
        selfRating: selfR,
        selfNote: 'Met all major objectives this cycle; some scope creep on Q2 deliverables.',
        managerRating: mgrR,
        managerNote: 'Solid contribution overall. Continue building on the leadership behaviours.',
        managerOverrodeSelf: mgrR !== selfR,
        finalRating: mgrR,
        lockedAt: closedCycle.closedAt,
      },
    });
    for (let g = 0; g < 3; g++) {
      await prisma.goal.create({
        data: {
          reviewId: review.id,
          text: GOAL_TEMPLATES[(i * 3 + g) % GOAL_TEMPLATES.length]!,
          outcomeId: ((g + i) % 3) + 2,
          proposedByEmployee: g === 2,
        },
      });
    }
  }

  const openEligible = allEmps.filter((e) => e.joinDate <= dt('2026-04-01') && e.status !== 5);
  for (let i = 0; i < openEligible.length; i++) {
    const e = openEligible[i]!;
    const managerId = e.reportingManagerId ?? adminEmp.id;
    const hasSelf = i % 2 === 0;
    const review = await prisma.performanceReview.create({
      data: {
        cycleId: openCycle.id,
        employeeId: e.id,
        managerId,
        selfRating: hasSelf ? 4 - (i % 2) : null,
        selfNote: hasSelf ? 'On track for cycle goals; will deepen the platform work in Q3.' : null,
        managerRating: null,
        managerNote: null,
        managerOverrodeSelf: false,
        finalRating: null,
        lockedAt: null,
      },
    });
    for (let g = 0; g < 3; g++) {
      await prisma.goal.create({
        data: {
          reviewId: review.id,
          text: GOAL_TEMPLATES[(i * 3 + g + 7) % GOAL_TEMPLATES.length]!,
          outcomeId: 1,
          proposedByEmployee: false,
        },
      });
    }
  }

  // ── Notifications ────────────────────────────────────────────────────────
  console.log('  [realistic] writing notifications…');
  const decidedLeaves = await prisma.leaveRequest.findMany({
    where: { status: { in: [2, 3, 5] } },
    orderBy: { id: 'asc' },
  });
  const notifRows: Prisma.NotificationCreateManyInput[] = [];
  for (const l of decidedLeaves) {
    notifRows.push({
      recipientId: l.employeeId,
      categoryId: 1,
      title:
        l.status === 2 ? `Leave ${l.code} approved`
        : l.status === 3 ? `Leave ${l.code} rejected`
        : `Leave ${l.code} escalated to Admin`,
      body:
        l.status === 2 ? `Your leave from ${l.fromDate.toISOString().slice(0, 10)} to ${l.toDate.toISOString().slice(0, 10)} has been approved.`
        : l.status === 3 ? `Your leave was rejected. Note: ${l.decisionNote ?? 'no comment'}.`
        : `Pending for >5 working days; routed to Admin queue.`,
      link: `/employee/leave/${l.code}`,
      unread: false,
      createdAt: l.decidedAt ?? l.escalatedAt ?? l.createdAt,
    });
  }
  const aprilRun = await prisma.payrollRun.findFirst({ where: { month: 4, year: REALISTIC_YEAR } });
  if (aprilRun) {
    const payslips = await prisma.payslip.findMany({
      where: { runId: aprilRun.id },
      select: { id: true, employeeId: true, netPayPaise: true },
      take: 24,
    });
    for (const p of payslips) {
      notifRows.push({
        recipientId: p.employeeId,
        categoryId: 3,
        title: 'April 2026 payslip ready',
        body: `Your payslip for April 2026 is ready. Net pay: ₹${(p.netPayPaise / 100).toLocaleString('en-IN')}.`,
        link: `/employee/payslips/${p.id}`,
        unread: true,
        createdAt: aprilRun.finalisedAt ?? aprilRun.initiatedAt,
      });
    }
  }
  await prisma.notification.createMany({ data: notifRows });

  // ── Audit log — coherent actors + roles + IPs ────────────────────────────
  console.log('  [realistic] writing audit log…');
  const OFFICE_IP = '192.168.1.';
  const REMOTE_IP = '49.205.';
  const roleIdByEmp = new Map<number, number>(allEmps.map((e) => [e.id, e.roleId]));
  const auditRows: Prisma.AuditLogCreateManyInput[] = [];

  let ipCounter = 1;
  for (let day = 13; day >= 0; day--) {
    for (const e of allEmps.slice(0, 12)) {
      const at = new Date(Date.now() - day * 86_400_000 - (ipCounter * 13) * 60_000);
      auditRows.push({
        actorId: e.id,
        actorRoleId: roleIdByEmp.get(e.id) ?? 1,
        actorIp: ipCounter % 5 === 0 ? `${REMOTE_IP}${100 + ipCounter}.${ipCounter % 254}` : `${OFFICE_IP}${50 + (ipCounter % 50)}`,
        action: 'auth.login.success',
        targetTypeId: 1,
        targetId: e.id,
        moduleId: 1,
        before: Prisma.JsonNull,
        after: { sessionId: ipCounter },
        createdAt: at,
      });
      ipCounter++;
    }
  }
  const allLeaves = await prisma.leaveRequest.findMany({ orderBy: { id: 'asc' } });
  for (const l of allLeaves) {
    auditRows.push({
      actorId: l.employeeId,
      actorRoleId: roleIdByEmp.get(l.employeeId) ?? 1,
      actorIp: `${OFFICE_IP}${50 + (l.id % 50)}`,
      action: 'leave.create',
      targetTypeId: 2,
      targetId: l.id,
      moduleId: 3,
      before: Prisma.JsonNull,
      after: { code: l.code, leaveTypeId: l.leaveTypeId, days: l.days, status: 1 },
      createdAt: l.createdAt,
    });
    if (l.status === 2 || l.status === 3) {
      const decider = l.decidedBy ?? l.approverId ?? adminEmp.id;
      auditRows.push({
        actorId: decider,
        actorRoleId: roleIdByEmp.get(decider) ?? 2,
        actorIp: `${OFFICE_IP}${50 + (l.id % 50)}`,
        action: l.status === 2 ? 'leave.approve' : 'leave.reject',
        targetTypeId: 2,
        targetId: l.id,
        moduleId: 3,
        before: { status: 1 },
        after: { status: l.status, decidedBy: l.decidedBy, decisionNote: l.decisionNote },
        createdAt: l.decidedAt ?? l.updatedAt,
      });
    }
  }
  const allRuns = await prisma.payrollRun.findMany({ orderBy: { id: 'asc' } });
  for (const r of allRuns) {
    auditRows.push({
      actorId: r.initiatedBy,
      actorRoleId: 3,
      actorIp: `${OFFICE_IP}80`,
      action: 'payroll.run.create',
      targetTypeId: 6,
      targetId: r.id,
      moduleId: 4,
      before: Prisma.JsonNull,
      after: { code: r.code, month: r.month, year: r.year, status: r.status },
      createdAt: r.initiatedAt,
    });
    if (r.status === 3 && r.finalisedBy) {
      auditRows.push({
        actorId: r.finalisedBy,
        actorRoleId: 4,
        actorIp: `${OFFICE_IP}81`,
        action: 'payroll.run.finalise',
        targetTypeId: 6,
        targetId: r.id,
        moduleId: 4,
        before: { status: 2 },
        after: { status: 3, finalisedAt: r.finalisedAt?.toISOString() },
        createdAt: r.finalisedAt!,
      });
    }
  }
  await prisma.auditLog.createMany({ data: auditRows });

  // ── Sessions / login attempts / reset tokens ─────────────────────────────
  console.log('  [realistic] writing sessions, login attempts, reset tokens…');
  const sessionUserAgents = [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605 Version/17.5 Safari/605',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/127',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605 Version/17.5 Safari/605',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
  ];
  const sessionTargets = [
    adminEmp.id, mgrEmp.id, empEmp.id, payEmp.id,
    allEmps.find((e) => e.code === 'EMP-2024-0010')!.id,
    allEmps.find((e) => e.code === 'EMP-2024-0015')!.id,
  ];
  await prisma.session.createMany({
    data: sessionTargets.map((eid, i) => ({
      token: crypto.randomBytes(32).toString('hex'),
      employeeId: eid,
      ip: `${OFFICE_IP}${60 + i}`,
      userAgent: sessionUserAgents[i] ?? sessionUserAgents[0]!,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      createdAt: new Date(Date.now() - i * 3600_000),
    })),
  });

  const loginEmps = allEmps.slice(0, 12);
  const attempts: Prisma.LoginAttemptCreateManyInput[] = [];
  for (let i = 0; i < 30; i++) {
    const e = loginEmps[i % loginEmps.length]!;
    const isFailure = i === 7 || i === 19 || i === 25;
    attempts.push({
      email: isFailure ? `${e.email.split('@')[0]}.x@triline.co.in` : e.email,
      ip: `${OFFICE_IP}${50 + (i % 50)}`,
      success: !isFailure,
      employeeId: isFailure ? null : e.id,
      createdAt: new Date(Date.now() - i * 6 * 3600_000),
    });
  }
  await prisma.loginAttempt.createMany({ data: attempts });

  const pooja = allEmps.find((e) => e.code === 'EMP-2024-0008')!;
  const suresh = allEmps.find((e) => e.code === 'EMP-2024-0023')!;
  const aditya = allEmps.find((e) => e.code === 'EMP-2024-0005')!;
  await prisma.passwordResetToken.createMany({
    data: [
      { tokenHash: crypto.createHash('sha256').update('reset-pooja-first-login').digest('hex'), employeeId: pooja.id, purposeId: 1, expiresAt: new Date(Date.now() + 5 * 86_400_000), usedAt: null, createdAt: new Date(Date.now() - 2 * 86_400_000) },
      { tokenHash: crypto.createHash('sha256').update('reset-suresh-first-login').digest('hex'), employeeId: suresh.id, purposeId: 1, expiresAt: new Date(Date.now() + 2 * 86_400_000), usedAt: null, createdAt: new Date(Date.now() - 5 * 86_400_000) },
      { tokenHash: crypto.createHash('sha256').update('reset-aditya-self').digest('hex'), employeeId: aditya.id, purposeId: 2, expiresAt: new Date(Date.now() + 1 * 3600_000), usedAt: null, createdAt: new Date(Date.now() - 6 * 3600_000) },
    ],
  });

  // ── Update code counters to match the highest codes used ─────────────────
  await prisma.leaveCodeCounter.create({ data: { year: REALISTIC_YEAR, number: leaveSeeds.length } });
  await prisma.regCodeCounter.create({ data: { year: REALISTIC_YEAR, number: regSeeds.length } });
  await prisma.encashmentCodeCounter.create({ data: { year: 2025, number: encSeeds.length } });
  for (const m of runMonths) {
    const c = await prisma.payslip.count({ where: { year: REALISTIC_YEAR, month: m } });
    await prisma.payrollCodeCounter.create({ data: { year: REALISTIC_YEAR, month: m, number: c } });
  }

  const payslipCount = await prisma.payslip.count();
  console.log('  [realistic] seed complete:');
  console.log(`              employees: ${allEmps.length}  leave_requests: ${leaveSeeds.length}  regularisations: ${regSeeds.length}`);
  console.log(`              encashments: ${encSeeds.length}  payroll_runs: ${runMonths.length}  payslips: ${payslipCount}`);
  console.log(`              attendance: ${attRows.length}  notifications: ${notifRows.length}  audit_log: ${auditRows.length}`);
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

  console.log('• Realistic data');
  await seedRealisticData();

  console.log('Seed complete.');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
