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

// ── Dummy data — populates every otherwise-empty table ──────────────────────
//
// Idempotent via a marker check on the first row of every section. Re-running
// the seed will not duplicate dummy data. Staging-only project — these rows
// give QA realistic shapes across every module.

import crypto from 'node:crypto';

const DUMMY_YEAR = 2026;

/** Generate a 32-hex token (used for session + reset tokens). */
const randomHex = (bytes = 32): string => crypto.randomBytes(bytes).toString('hex');

/** Fixed pseudo-IP rotator so dummy data looks plausible. */
const fakeIp = (i: number): string => `10.0.${(i >> 8) & 0xff}.${i & 0xff}`;

async function seedDummyData(): Promise<void> {
  // Marker check — if L-2026-0001 already exists, the dummy block has already run.
  const marker = await prisma.leaveRequest.findFirst({ where: { code: 'L-2026-0001' } });
  if (marker) {
    console.log('  [dummy] already seeded, skipping');
    return;
  }

  // Resolve the 4 demo employees by stable email.
  const [adminEmp, mgrEmp, empEmp, payEmp] = await Promise.all([
    prisma.employee.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } }),
    prisma.employee.findUniqueOrThrow({ where: { email: 'manager@triline.co.in' } }),
    prisma.employee.findUniqueOrThrow({ where: { email: 'employee@triline.co.in' } }),
    prisma.employee.findUniqueOrThrow({ where: { email: 'payroll@triline.co.in' } }),
  ]);
  const employees = [adminEmp, mgrEmp, empEmp, payEmp]; // ids 1..4
  const empIds = employees.map((e) => e.id);

  // ── sessions (20) — 5 per employee, all active for 30 days ────────────────
  const now = new Date();
  await prisma.session.createMany({
    data: Array.from({ length: 20 }, (_, i) => ({
      token: randomHex(),
      employeeId: empIds[i % 4]!,
      ip: fakeIp(i),
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) NexoraSeed/1.0',
      expiresAt: new Date(now.getTime() + (30 - i) * 86_400_000),
    })),
  });

  // ── login_attempts (+17) — mix of success/failure ─────────────────────────
  await prisma.loginAttempt.createMany({
    data: Array.from({ length: 17 }, (_, i) => {
      const emp = employees[i % 4]!;
      const success = i % 3 !== 0;
      return {
        email: emp.email,
        ip: fakeIp(i + 100),
        success,
        employeeId: success ? emp.id : null,
        createdAt: new Date(now.getTime() - (17 - i) * 3_600_000),
      };
    }),
  });

  // ── password_reset_tokens (20) ───────────────────────────────────────────
  await prisma.passwordResetToken.createMany({
    data: Array.from({ length: 20 }, (_, i) => {
      const used = i % 3 === 0;
      const expired = i % 4 === 0;
      const exp = new Date(now.getTime() + (expired ? -86_400_000 : 86_400_000));
      return {
        tokenHash: crypto.createHash('sha256').update(`reset-${i}-${Date.now()}`).digest('hex'),
        employeeId: empIds[i % 4]!,
        purposeId: i % 5 === 0 ? 1 : 2, // 1=FirstLogin, 2=ResetPassword
        expiresAt: exp,
        usedAt: used ? new Date(now.getTime() - 3_600_000 * i) : null,
      };
    }),
  });

  // ── leave_requests (20) + leave_code_counter ──────────────────────────────
  const leaveRequestsData = Array.from({ length: 20 }, (_, i) => {
    const emp = employees[i % 4]!;
    const leaveTypeId = ((i % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6;
    const isEventBased = leaveTypeId === 5 || leaveTypeId === 6;
    // Manager (id=2) approves emp's requests; admin (id=1) approves mgr/payroll;
    // event-based always goes to admin.
    const routedToId = isEventBased
      ? 2 // Admin
      : emp.id === empEmp.id
        ? 1 // Manager
        : 2; // Admin (for mgr/payroll/admin requesters)
    const approverId = routedToId === 1 ? mgrEmp.id : adminEmp.id;
    const status = ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5;
    const decided = status === 2 || status === 3 || status === 4;
    const from = new Date(Date.UTC(DUMMY_YEAR, 3 + (i % 3), 5 + (i % 20)));
    const to = new Date(from.getTime() + (i % 3) * 86_400_000);
    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1);
    return {
      code: `L-${DUMMY_YEAR}-${String(i + 1).padStart(4, '0')}`,
      employeeId: emp.id,
      leaveTypeId,
      fromDate: from,
      toDate: to,
      days,
      reason: `Sample leave request #${i + 1}`,
      status,
      routedToId,
      approverId: decided ? approverId : null,
      decidedAt: decided ? new Date(now.getTime() - (20 - i) * 3_600_000) : null,
      decidedBy: decided ? approverId : null,
      decisionNote: decided && status === 3 ? 'Insufficient notice.' : null,
      escalatedAt: status === 5 ? new Date(now.getTime() - i * 86_400_000) : null,
      cancelledAt: status === 4 ? new Date(now.getTime() - i * 3_600_000) : null,
      cancelledBy: status === 4 ? emp.id : null,
      cancelledAfterStart: status === 4 && i % 2 === 0,
      deductedDays: status === 2 ? days : 0,
      restoredDays: status === 4 ? days : 0,
    };
  });
  await prisma.leaveRequest.createMany({ data: leaveRequestsData });

  await prisma.leaveCodeCounter.upsert({
    where: { year: DUMMY_YEAR },
    create: { year: DUMMY_YEAR, number: 20 },
    update: { number: 20 },
  });

  // ── leave_balance_ledger (20) — initial allocations + approval deductions ─
  const ledgerSeeds: Array<{
    employeeId: number;
    leaveTypeId: number;
    delta: number;
    reasonId: number;
  }> = [];
  // Initial allocation entries — 4 employees × 4 accrual types = 16
  for (const emp of employees) {
    for (const lt of [1, 2, 3, 4]) {
      ledgerSeeds.push({ employeeId: emp.id, leaveTypeId: lt, delta: 12, reasonId: 1 }); // Initial
    }
  }
  // 4 approval deductions
  for (let i = 0; i < 4; i++) {
    ledgerSeeds.push({
      employeeId: empIds[i]!,
      leaveTypeId: 1,
      delta: -2,
      reasonId: 2, // Approval
    });
  }
  await prisma.leaveBalanceLedger.createMany({
    data: ledgerSeeds.map((s, i) => ({
      ...s,
      year: DUMMY_YEAR,
      createdAt: new Date(now.getTime() - (ledgerSeeds.length - i) * 60_000),
    })),
  });

  // ── attendance_records (20) — 5 days × 4 employees, all source=1 (system) ─
  await prisma.attendanceRecord.createMany({
    data: Array.from({ length: 20 }, (_, i) => {
      const emp = employees[i % 4]!;
      const dayOffset = Math.floor(i / 4);
      const date = new Date(Date.UTC(DUMMY_YEAR, 4, 5 + dayOffset));
      const status = dayOffset === 4 ? 4 : 1; // last batch = WeeklyOff; rest = Present
      const checkIn = status === 1 ? new Date(date.getTime() + 9 * 3_600_000 + (i % 3) * 1800_000) : null;
      const checkOut = checkIn ? new Date(checkIn.getTime() + 9 * 3_600_000) : null;
      const late = checkIn ? checkIn.getUTCHours() * 60 + checkIn.getUTCMinutes() > 10 * 60 + 30 : false;
      return {
        employeeId: emp.id,
        date,
        status,
        checkInTime: checkIn,
        checkOutTime: checkOut,
        hoursWorkedMinutes: checkIn ? 540 : null,
        late,
        lateMonthCount: late ? 1 : 0,
        lopApplied: false,
        sourceId: 1, // system
        regularisationId: null,
      };
    }),
  });

  // ── attendance_late_ledger (20) — 4 emps × 5 months ───────────────────────
  await prisma.attendanceLateLedger.createMany({
    data: Array.from({ length: 20 }, (_, i) => ({
      employeeId: empIds[i % 4]!,
      year: DUMMY_YEAR,
      month: Math.floor(i / 4) + 1, // 1..5
      count: i % 4,
    })),
  });

  // ── regularisation_requests (20) + counter ────────────────────────────────
  await prisma.regularisationRequest.createMany({
    data: Array.from({ length: 20 }, (_, i) => {
      const emp = employees[i % 4]!;
      const status = ((i % 3) + 1) as 1 | 2 | 3;
      const ageDays = (i % 14) + 1;
      const routedToId = ageDays > 7 ? 2 : 1; // BL-029
      const approverId = routedToId === 1 ? mgrEmp.id : adminEmp.id;
      const decided = status !== 1;
      const date = new Date(Date.UTC(DUMMY_YEAR, 3, 1 + (i % 28)));
      const ci = new Date(date.getTime() + 9 * 3_600_000 + (i % 3) * 1800_000);
      const co = new Date(date.getTime() + 18 * 3_600_000);
      return {
        code: `R-${DUMMY_YEAR}-${String(i + 1).padStart(4, '0')}`,
        employeeId: emp.id,
        date,
        proposedCheckIn: ci,
        proposedCheckOut: co,
        reason: `Forgot to check in/out — dummy reason #${i + 1}`,
        status,
        routedToId,
        ageDaysAtSubmit: ageDays,
        approverId: decided ? approverId : null,
        decidedAt: decided ? new Date(now.getTime() - i * 3_600_000) : null,
        decidedBy: decided ? approverId : null,
        decisionNote: decided && status === 3 ? 'No corroborating evidence.' : null,
      };
    }),
  });

  await prisma.regCodeCounter.upsert({
    where: { year: DUMMY_YEAR },
    create: { year: DUMMY_YEAR, number: 20 },
    update: { number: 20 },
  });

  // ── leave_encashments (20) + counter ──────────────────────────────────────
  await prisma.leaveEncashment.createMany({
    data: Array.from({ length: 20 }, (_, i) => {
      const emp = employees[i % 4]!;
      const status = ((i % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6;
      const routedToId = status === 1 ? 1 : 2;
      const approverId = routedToId === 1 ? mgrEmp.id : adminEmp.id;
      const decided = status !== 1;
      const daysReq = (i % 5) + 1;
      const daysApp = status >= 3 ? daysReq : null;
      const rate = daysApp ? 200000 : null; // ₹2000/day in paise
      return {
        code: `LE-${DUMMY_YEAR}-${String(i + 1).padStart(4, '0')}`,
        employeeId: emp.id,
        year: DUMMY_YEAR,
        daysRequested: daysReq,
        daysApproved: daysApp,
        ratePerDayPaise: rate,
        amountPaise: daysApp && rate ? daysApp * rate : null,
        status,
        routedToId,
        approverId: decided ? approverId : null,
        decidedAt: decided ? new Date(now.getTime() - i * 86_400_000) : null,
        decidedBy: decided ? approverId : null,
        decisionNote: status === 5 ? 'Outside encashment window.' : null,
        paidAt: status === 4 ? new Date(now.getTime() - i * 3_600_000) : null,
        cancelledAt: status === 6 ? new Date(now.getTime() - i * 3_600_000) : null,
        cancelledBy: status === 6 ? emp.id : null,
      };
    }),
  });

  await prisma.encashmentCodeCounter.upsert({
    where: { year: DUMMY_YEAR },
    create: { year: DUMMY_YEAR, number: 20 },
    update: { number: 20 },
  });

  // ── payroll_runs (5) + counters + payslips (20) ───────────────────────────
  // 5 runs: Jan–May 2026. Jan–Apr Finalised (status=3), May Review (status=2).
  const runRows = [];
  for (let m = 1; m <= 5; m++) {
    const finalised = m <= 4;
    const periodStart = new Date(Date.UTC(DUMMY_YEAR, m - 1, 1));
    const periodEnd = new Date(Date.UTC(DUMMY_YEAR, m, 0));
    runRows.push({
      code: `RUN-${DUMMY_YEAR}-${String(m).padStart(2, '0')}`,
      month: m,
      year: DUMMY_YEAR,
      status: finalised ? 3 : 2,
      workingDays: 22,
      periodStart,
      periodEnd,
      initiatedBy: payEmp.id,
      initiatedAt: new Date(periodEnd.getTime() - 86_400_000),
      finalisedBy: finalised ? adminEmp.id : null,
      finalisedAt: finalised ? new Date(periodEnd.getTime() + 86_400_000) : null,
    });
  }
  await prisma.payrollRun.createMany({ data: runRows });

  await prisma.payrollCodeCounter.createMany({
    data: runRows.map((r) => ({ year: r.year, month: r.month, number: 1 })),
  });

  const runs = await prisma.payrollRun.findMany({
    where: { year: DUMMY_YEAR },
    orderBy: { month: 'asc' },
  });

  // Payslips: 5 runs × 4 employees = 20
  const payslips: Array<Parameters<typeof prisma.payslip.createMany>[0]['data']> = [];
  let psIdx = 0;
  for (const run of runs) {
    for (const emp of employees) {
      psIdx++;
      const basic = 5_000_000; // ₹50,000 in paise
      const allow = 2_000_000; // ₹20,000
      const gross = basic + allow;
      const tax = Math.round(gross * 0.095);
      const other = 200_000;
      const net = gross - tax - other;
      payslips.push({
        code: `P-${DUMMY_YEAR}-${String(run.month).padStart(2, '0')}-${String(psIdx).padStart(4, '0')}`,
        runId: run.id,
        employeeId: emp.id,
        month: run.month,
        year: DUMMY_YEAR,
        status: run.status,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        workingDays: 22,
        daysWorked: 22,
        lopDays: 0,
        basicPaise: basic,
        allowancesPaise: allow,
        grossPaise: gross,
        lopDeductionPaise: 0,
        referenceTaxPaise: tax,
        finalTaxPaise: tax,
        otherDeductionsPaise: other,
        netPayPaise: net,
        finalisedAt: run.finalisedAt,
      } as never);
    }
  }
  for (const p of payslips) {
    await prisma.payslip.create({ data: p as never });
  }

  // ── performance_cycles (2) + reviews (8) + goals (20) ─────────────────────
  await prisma.performanceCycle.createMany({
    data: [
      {
        code: `C-${DUMMY_YEAR - 1}-H2`,
        fyStart: new Date(Date.UTC(DUMMY_YEAR - 1, 9, 1)),
        fyEnd: new Date(Date.UTC(DUMMY_YEAR, 2, 31)),
        status: 4, // Closed
        selfReviewDeadline: new Date(Date.UTC(DUMMY_YEAR, 1, 15)),
        managerReviewDeadline: new Date(Date.UTC(DUMMY_YEAR, 2, 1)),
        closedAt: new Date(Date.UTC(DUMMY_YEAR, 2, 5)),
        closedBy: adminEmp.id,
        createdBy: adminEmp.id,
      },
      {
        code: `C-${DUMMY_YEAR}-H1`,
        fyStart: new Date(Date.UTC(DUMMY_YEAR, 3, 1)),
        fyEnd: new Date(Date.UTC(DUMMY_YEAR, 8, 30)),
        status: 1, // Open
        selfReviewDeadline: new Date(Date.UTC(DUMMY_YEAR, 7, 15)),
        managerReviewDeadline: new Date(Date.UTC(DUMMY_YEAR, 8, 1)),
        createdBy: adminEmp.id,
      },
    ],
  });

  const cycles = await prisma.performanceCycle.findMany({ orderBy: { fyStart: 'asc' } });

  // 4 employees × 2 cycles = 8 reviews
  for (const cycle of cycles) {
    for (const emp of employees) {
      const isClosed = cycle.status === 4;
      // Manager: emp's reportingManager OR a peer admin for admin/payroll
      let managerId: number | null = emp.reportingManagerId;
      if (!managerId) managerId = adminEmp.id === emp.id ? null : adminEmp.id;
      const self = isClosed ? 4 : 3;
      const mgr = isClosed ? 4 : null;
      await prisma.performanceReview.create({
        data: {
          cycleId: cycle.id,
          employeeId: emp.id,
          managerId,
          selfRating: self,
          selfNote: 'Met all key objectives this cycle.',
          managerRating: mgr,
          managerNote: mgr ? 'Solid performance — exceeded expectations on the Q3 launch.' : null,
          managerOverrodeSelf: mgr !== null && self !== mgr,
          finalRating: isClosed ? mgr : null,
          lockedAt: isClosed ? cycle.closedAt : null,
        },
      });
    }
  }

  // 20 goals = 2 goals × 4 reviews (closed cycle) + 3 goals × 4 reviews (open cycle)
  const reviews = await prisma.performanceReview.findMany({ orderBy: { id: 'asc' } });
  let goalCount = 0;
  for (const r of reviews) {
    const isClosed = cycles.find((c) => c.id === r.cycleId)!.status === 4;
    const goalsPerReview = isClosed ? 2 : 3;
    for (let g = 0; g < goalsPerReview; g++) {
      goalCount++;
      await prisma.goal.create({
        data: {
          reviewId: r.id,
          text: `Goal #${g + 1}: deliver the Q${g + 1} milestone on time and within budget.`,
          outcomeId: isClosed ? ((g % 3) + 2) : 1, // closed=Met/Partial/Missed; open=Pending
          proposedByEmployee: g === 0,
        },
      });
    }
  }

  // ── notifications (20) ────────────────────────────────────────────────────
  await prisma.notification.createMany({
    data: Array.from({ length: 20 }, (_, i) => {
      const recipient = employees[i % 4]!;
      const categoryId = ((i % 8) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
      const titles: Record<number, string> = {
        1: 'Leave request approved',
        2: 'Late mark recorded for today',
        3: 'Payslip ready for download',
        4: 'Self-review window opens tomorrow',
        5: 'Your reporting manager has changed',
        6: 'Late threshold updated by Admin',
        7: 'New session signed in from 10.0.0.42',
        8: 'System maintenance window: Saturday 2 AM IST',
      };
      return {
        recipientId: recipient.id,
        categoryId,
        title: titles[categoryId]!,
        body: `Dummy notification body #${i + 1} — auto-generated for staging QA.`,
        link: null,
        unread: i % 3 !== 0,
        createdAt: new Date(now.getTime() - (20 - i) * 1_800_000),
      };
    }),
  });

  // ── audit_log (20) ────────────────────────────────────────────────────────
  const auditActions = [
    { action: 'auth.login.success',           moduleId: 1, targetTypeId: 1 },
    { action: 'auth.login.failure',           moduleId: 1, targetTypeId: 1 },
    { action: 'employee.created',             moduleId: 2, targetTypeId: 1 },
    { action: 'employee.status.changed',      moduleId: 2, targetTypeId: 1 },
    { action: 'employee.salary.updated',      moduleId: 2, targetTypeId: 12 },
    { action: 'leave.request.created',        moduleId: 3, targetTypeId: 2 },
    { action: 'leave.request.approved',       moduleId: 3, targetTypeId: 2 },
    { action: 'leave.request.rejected',       moduleId: 3, targetTypeId: 2 },
    { action: 'leave.encashment.created',     moduleId: 3, targetTypeId: 3 },
    { action: 'leave.encashment.approved',    moduleId: 3, targetTypeId: 3 },
    { action: 'attendance.checkin',           moduleId: 5, targetTypeId: 4 },
    { action: 'attendance.checkout',          moduleId: 5, targetTypeId: 4 },
    { action: 'regularisation.approved',      moduleId: 5, targetTypeId: 5 },
    { action: 'payroll.run.initiated',        moduleId: 4, targetTypeId: 6 },
    { action: 'payroll.run.finalised',        moduleId: 4, targetTypeId: 6 },
    { action: 'performance.cycle.created',    moduleId: 6, targetTypeId: 8 },
    { action: 'performance.review.submitted', moduleId: 6, targetTypeId: 9 },
    { action: 'configuration.updated',        moduleId: 9, targetTypeId: 11 },
    { action: 'holiday.created',              moduleId: 9, targetTypeId: 13 },
    { action: 'notification.delivered',       moduleId: 7, targetTypeId: 14 },
  ];
  await prisma.auditLog.createMany({
    data: auditActions.map((a, i) => ({
      actorId: empIds[i % 4]!,
      actorRoleId: ((i % 4) + 1), // 1..4
      actorIp: fakeIp(i + 200),
      action: a.action,
      moduleId: a.moduleId,
      targetTypeId: a.targetTypeId,
      targetId: (i % 20) + 1,
      before: null,
      after: { sample: true, n: i },
      createdAt: new Date(now.getTime() - (20 - i) * 600_000),
    })),
  });

  // ── idempotency_keys (20) ─────────────────────────────────────────────────
  await prisma.idempotencyKey.createMany({
    data: Array.from({ length: 20 }, (_, i) => ({
      key: `idem-${DUMMY_YEAR}-${randomHex(8)}`,
      employeeId: empIds[i % 4]!,
      endpoint: ['/leave/requests', '/attendance/check-in', '/payroll/runs', '/leave-encashments'][i % 4]!,
      responseSnapshot: { ok: true, n: i },
      createdAt: new Date(now.getTime() - (20 - i) * 300_000),
    })),
  });

  console.log('  [dummy] seeded: sessions(20) login_attempts(+17) reset_tokens(20)');
  console.log('  [dummy]         leave_requests(20) ledger(20) attendance(20) late_ledger(20)');
  console.log('  [dummy]         regularisations(20) encashments(20) payroll_runs(5) payslips(20)');
  console.log('  [dummy]         cycles(2) reviews(8) goals(20) notifications(20) audit(20) idem(20)');
}

// ── Expanded attendance — fills a wide date range so the admin grid has data ─
//
// Independent of the 20-row dummy block; runs idempotently even after that
// block has fired. Looks for the marker date 2026-04-01: if any row exists
// for that date, the expansion is already in place and the function returns
// early. Otherwise it generates one row per (active demo employee × every
// weekday between EXPANDED_FROM and EXPANDED_TO), skipping public holidays.
//
// Status distribution is deterministic (not Math.random) so re-running on a
// fresh DB produces byte-for-byte identical rows. Mix: ~70% Present (with
// ~20% of those late after 10:30), ~10% Absent, ~10% OnLeave.
//
// Uses createMany({ skipDuplicates: true }) so any rows that already exist
// (e.g., the 20-row dummy block's May 5–9 entries) are silently skipped.

const EXPANDED_FROM = new Date(Date.UTC(2026, 3, 1));  // 2026-04-01
const EXPANDED_TO   = new Date(Date.UTC(2026, 4, 31)); // 2026-05-31

async function seedExpandedAttendance(): Promise<void> {
  const marker = await prisma.attendanceRecord.findFirst({
    where: { date: EXPANDED_FROM },
    select: { id: true },
  });
  if (marker) {
    console.log('  [att-expanded] already seeded, skipping');
    return;
  }

  const [adminEmp, mgrEmp, empEmp, payEmp] = await Promise.all([
    prisma.employee.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } }),
    prisma.employee.findUniqueOrThrow({ where: { email: 'manager@triline.co.in' } }),
    prisma.employee.findUniqueOrThrow({ where: { email: 'employee@triline.co.in' } }),
    prisma.employee.findUniqueOrThrow({ where: { email: 'payroll@triline.co.in' } }),
  ]);
  const employees = [adminEmp, mgrEmp, empEmp, payEmp];

  const holidays = await prisma.holiday.findMany({ select: { date: true } });
  const holidayKeys = new Set(holidays.map((h) => h.date.toISOString().slice(0, 10)));

  type Row = {
    employeeId: number;
    date: Date;
    status: number;
    checkInTime: Date | null;
    checkOutTime: Date | null;
    hoursWorkedMinutes: number | null;
    late: boolean;
    lateMonthCount: number;
    lopApplied: boolean;
    sourceId: number;
  };
  const rows: Row[] = [];

  let cellIdx = 0;
  for (
    let d = new Date(EXPANDED_FROM);
    d <= EXPANDED_TO;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip Sat/Sun
    const key = d.toISOString().slice(0, 10);
    if (holidayKeys.has(key)) continue;

    for (const emp of employees) {
      cellIdx++;
      // 10-cell rotation: 0=Absent, 1=OnLeave, 2..9=Present (8 = late present)
      const slot = cellIdx % 10;
      let status: number;
      let late = false;
      let checkIn: Date | null = null;
      let checkOut: Date | null = null;
      let hours: number | null = null;

      if (slot === 0) {
        status = 2; // Absent
      } else if (slot === 1) {
        status = 3; // OnLeave
      } else {
        status = 1; // Present
        const isLate = slot === 8 || slot === 9; // 20% of present
        const lateMin = isLate ? 45 : 0; // 11:15 IST when late
        late = isLate;
        // Check-in at 09:00 IST (03:30 UTC), check-out at 18:00 IST (12:30 UTC)
        const dayBase = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        checkIn  = new Date(dayBase.getTime() + (3 * 60 + 30 + lateMin) * 60_000);
        checkOut = new Date(dayBase.getTime() + (12 * 60 + 30) * 60_000);
        hours = 540 - lateMin; // 9h minus the late minutes
      }

      rows.push({
        employeeId: emp.id,
        date: new Date(d.getTime()), // clone, loop mutates `d`
        status,
        checkInTime: checkIn,
        checkOutTime: checkOut,
        hoursWorkedMinutes: hours,
        late,
        lateMonthCount: 0, // denorm cache; left at 0 for seed data
        lopApplied: false,
        sourceId: 1, // system
      });
    }
  }

  const result = await prisma.attendanceRecord.createMany({
    data: rows,
    skipDuplicates: true,
  });

  console.log(
    `  [att-expanded] inserted ${result.count} rows (attempted ${rows.length}; ` +
      `${rows.length - result.count} skipped as duplicates)`,
  );
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

  console.log('• Dummy data');
  await seedDummyData();

  console.log('• Expanded attendance');
  await seedExpandedAttendance();

  console.log('Seed complete.');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
