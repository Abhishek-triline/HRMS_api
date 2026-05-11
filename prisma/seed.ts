/**
 * Nexora HRMS — Database seed (Phase 0 + Phase 2 + Phase 3)
 *
 * Idempotent: safe to run multiple times.
 * Creates:
 *   1. Configuration rows (all Phase-0 configurable defaults)
 *   2. Default admin employee — admin@triline.co.in / admin@123
 *      code EMP-2024-0001, mustResetPassword=false
 *   3. 6 LeaveType rows with proper flags + caps (Phase 2)
 *   4. LeaveQuota rows for 4 employment types × 4 accrual types (Phase 2)
 *   5. LeaveBalance rows for the admin for the current year (Phase 2)
 *   6. Holiday calendar for the current year (Phase 3)
 */

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

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
];

// ── Admin defaults (override via env) ────────────────────────────────────────

const ADMIN_EMAIL = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@triline.co.in';
const ADMIN_PASSWORD = process.env['SEED_ADMIN_PASSWORD'] ?? 'admin@123';

async function seedConfiguration(): Promise<void> {
  let created = 0;
  let skipped = 0;

  for (const { key, value } of CONFIG_DEFAULTS) {
    const existing = await prisma.configuration.findUnique({ where: { key } });
    if (existing) {
      skipped++;
    } else {
      await prisma.configuration.create({
        data: { key, value: value as never, updatedBy: 'seed' },
      });
      created++;
      console.log(`  [config] Created: ${key} = ${JSON.stringify(value)}`);
    }
  }

  if (skipped > 0) {
    console.log(`  [config] Skipped ${skipped} existing configuration rows.`);
  }
  console.log(`  [config] Created ${created} new configuration rows.`);
}

async function seedAdmin(): Promise<void> {
  const existing = await prisma.employee.findUnique({ where: { email: ADMIN_EMAIL } });

  if (existing) {
    console.log(`  [admin] Already exists (${ADMIN_EMAIL}) — skipping employee row.`);

    // Phase 1: idempotently add SalaryStructure and ReportingManagerHistory if missing
    const hasSalary = await prisma.salaryStructure.findFirst({
      where: { employeeId: existing.id },
    });
    if (!hasSalary) {
      await prisma.salaryStructure.create({
        data: {
          employeeId: existing.id,
          basicPaise: 0,
          allowancesPaise: 0,
          effectiveFrom: existing.joinDate,
          version: 0,
        },
      });
      console.log(`  [admin] Created initial SalaryStructure for admin.`);
    }

    const hasHistory = await prisma.reportingManagerHistory.findFirst({
      where: { employeeId: existing.id },
    });
    if (!hasHistory) {
      await prisma.reportingManagerHistory.create({
        data: {
          employeeId: existing.id,
          managerId: null,
          fromDate: existing.joinDate,
          toDate: null,
          reason: 'Initial',
        },
      });
      console.log(`  [admin] Created initial ReportingManagerHistory for admin.`);
    }

    return;
  }

  const passwordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id });
  const joinDate = new Date('2024-01-01');

  const admin = await prisma.employee.create({
    data: {
      code: 'EMP-2024-0001',
      email: ADMIN_EMAIL,
      name: 'Priya Sharma',
      passwordHash,
      role: 'Admin',
      status: 'Active',
      employmentType: 'Permanent',
      department: 'HR',
      designation: 'Head of People',
      reportingManagerId: null,
      joinDate,
      exitDate: null,
      mustResetPassword: false,
      version: 0,
    },
  });

  // Phase 1: initial salary structure (zeroed — Admin may update)
  await prisma.salaryStructure.create({
    data: {
      employeeId: admin.id,
      basicPaise: 0,
      allowancesPaise: 0,
      effectiveFrom: joinDate,
      version: 0,
    },
  });

  // Phase 1: initial reporting manager history row
  await prisma.reportingManagerHistory.create({
    data: {
      employeeId: admin.id,
      managerId: null,
      fromDate: joinDate,
      toDate: null,
      reason: 'Initial',
    },
  });

  console.log(`  [admin] Created admin employee: ${ADMIN_EMAIL}`);
  console.log(`  [admin] Code: EMP-2024-0001, Name: Priya Sharma`);
  console.log(`  [admin] IMPORTANT: Change the password immediately in production.`);
}

// ── Leave type definitions (Phase 2) ─────────────────────────────────────────

interface LeaveTypeDef {
  name: string;
  isEventBased: boolean;
  requiresAdminApproval: boolean;
  carryForwardCap: number | null;
  maxDaysPerEvent: number | null;
}

const LEAVE_TYPES: LeaveTypeDef[] = [
  {
    name: 'Annual',
    isEventBased: false,
    requiresAdminApproval: false,
    carryForwardCap: 10,
    maxDaysPerEvent: null,
  },
  {
    name: 'Sick',
    isEventBased: false,
    requiresAdminApproval: false,
    carryForwardCap: 0,   // BL-012: Sick does NOT carry forward
    maxDaysPerEvent: null,
  },
  {
    name: 'Casual',
    isEventBased: false,
    requiresAdminApproval: false,
    carryForwardCap: 5,
    maxDaysPerEvent: null,
  },
  {
    name: 'Unpaid',
    isEventBased: false,
    requiresAdminApproval: false,
    carryForwardCap: 0,
    maxDaysPerEvent: null,
  },
  {
    name: 'Maternity',
    isEventBased: true,
    requiresAdminApproval: true,
    carryForwardCap: null,
    maxDaysPerEvent: 182, // 26 weeks (BL-015)
  },
  {
    name: 'Paternity',
    isEventBased: true,
    requiresAdminApproval: true,
    carryForwardCap: null,
    maxDaysPerEvent: 10,  // 10 working days (BL-016)
  },
];

// ── Leave quotas — days per year per employment type (Phase 2) ────────────────

interface QuotaDef {
  leaveTypeName: string;
  employmentType: string;
  daysPerYear: number;
}

// Maternity/Paternity have no quota rows (event-based, no annual limit).
// Unpaid daysPerYear = 0 (no annual cap; server allows any duration at request time).
const LEAVE_QUOTAS: QuotaDef[] = [
  // Annual
  { leaveTypeName: 'Annual', employmentType: 'Permanent', daysPerYear: 18 },
  { leaveTypeName: 'Annual', employmentType: 'Contract',  daysPerYear: 12 },
  { leaveTypeName: 'Annual', employmentType: 'Probation', daysPerYear: 6  },
  { leaveTypeName: 'Annual', employmentType: 'Intern',    daysPerYear: 3  },
  // Sick
  { leaveTypeName: 'Sick',   employmentType: 'Permanent', daysPerYear: 10 },
  { leaveTypeName: 'Sick',   employmentType: 'Contract',  daysPerYear: 7  },
  { leaveTypeName: 'Sick',   employmentType: 'Probation', daysPerYear: 5  },
  { leaveTypeName: 'Sick',   employmentType: 'Intern',    daysPerYear: 3  },
  // Casual — Test Cases § 1.1 sets the seed reference at 6 for Permanent.
  { leaveTypeName: 'Casual', employmentType: 'Permanent', daysPerYear: 6  },
  { leaveTypeName: 'Casual', employmentType: 'Contract',  daysPerYear: 4  },
  { leaveTypeName: 'Casual', employmentType: 'Probation', daysPerYear: 3  },
  { leaveTypeName: 'Casual', employmentType: 'Intern',    daysPerYear: 2  },
  // Unpaid — represented as 0 (no annual limit; handled at request time)
  { leaveTypeName: 'Unpaid', employmentType: 'Permanent', daysPerYear: 0  },
  { leaveTypeName: 'Unpaid', employmentType: 'Contract',  daysPerYear: 0  },
  { leaveTypeName: 'Unpaid', employmentType: 'Probation', daysPerYear: 0  },
  { leaveTypeName: 'Unpaid', employmentType: 'Intern',    daysPerYear: 0  },
];

async function seedLeaveTypes(): Promise<void> {
  let created = 0;
  let skipped = 0;

  for (const lt of LEAVE_TYPES) {
    const existing = await prisma.leaveType.findUnique({ where: { name: lt.name } });
    if (existing) {
      skipped++;
    } else {
      await prisma.leaveType.create({ data: lt });
      created++;
      console.log(`  [leave-type] Created: ${lt.name}`);
    }
  }

  if (skipped > 0) console.log(`  [leave-type] Skipped ${skipped} existing leave type rows.`);
  console.log(`  [leave-type] Created ${created} new leave type rows.`);
}

async function seedLeaveQuotas(): Promise<void> {
  let created = 0;
  let skipped = 0;

  for (const q of LEAVE_QUOTAS) {
    const leaveType = await prisma.leaveType.findUnique({ where: { name: q.leaveTypeName } });
    if (!leaveType) {
      console.warn(`  [leave-quota] Leave type '${q.leaveTypeName}' not found — skipping quota.`);
      continue;
    }

    const existing = await prisma.leaveQuota.findUnique({
      where: {
        leaveTypeId_employmentType: {
          leaveTypeId: leaveType.id,
          employmentType: q.employmentType as never,
        },
      },
    });

    if (existing) {
      skipped++;
    } else {
      await prisma.leaveQuota.create({
        data: {
          leaveTypeId: leaveType.id,
          employmentType: q.employmentType as never,
          daysPerYear: q.daysPerYear,
        },
      });
      created++;
    }
  }

  if (skipped > 0) console.log(`  [leave-quota] Skipped ${skipped} existing quota rows.`);
  console.log(`  [leave-quota] Created ${created} new quota rows.`);
}

async function seedAdminLeaveBalances(): Promise<void> {
  const admin = await prisma.employee.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!admin) {
    console.warn('  [leave-balance] Admin not found — skipping leave balance seed.');
    return;
  }

  const year = new Date().getFullYear();
  let created = 0;
  let skipped = 0;

  // Seed balances for all accrual leave types based on Permanent quotas
  const accrualTypes = ['Annual', 'Sick', 'Casual', 'Unpaid'];

  for (const typeName of accrualTypes) {
    const leaveType = await prisma.leaveType.findUnique({ where: { name: typeName } });
    if (!leaveType) continue;

    const quota = await prisma.leaveQuota.findUnique({
      where: {
        leaveTypeId_employmentType: {
          leaveTypeId: leaveType.id,
          employmentType: 'Permanent',
        },
      },
    });

    const daysRemaining = quota?.daysPerYear ?? 0;

    const existing = await prisma.leaveBalance.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: admin.id,
          leaveTypeId: leaveType.id,
          year,
        },
      },
    });

    if (existing) {
      skipped++;
    } else {
      await prisma.leaveBalance.create({
        data: {
          employeeId: admin.id,
          leaveTypeId: leaveType.id,
          year,
          daysRemaining,
          daysUsed: 0,
          version: 0,
        },
      });

      // Ledger entry for the initial grant
      if (daysRemaining > 0) {
        await prisma.leaveBalanceLedger.create({
          data: {
            employeeId: admin.id,
            leaveTypeId: leaveType.id,
            year,
            delta: daysRemaining,
            reason: 'Initial',
            relatedRequestId: null,
            createdBy: null,
          },
        });
      }

      created++;
      console.log(`  [leave-balance] Created ${typeName} balance for admin: ${daysRemaining} days (${year})`);
    }
  }

  if (skipped > 0) console.log(`  [leave-balance] Skipped ${skipped} existing balance rows.`);
  console.log(`  [leave-balance] Created ${created} new balance rows for admin.`);
}

// ── Holiday calendar (Phase 3) ────────────────────────────────────────────────

interface HolidayDef {
  month: number; // 1-indexed
  day: number;
  name: string;
}

// Test-case seed list (not load-bearing — precise names don't matter for tests)
const SEED_HOLIDAYS: HolidayDef[] = [
  { month: 1, day: 26, name: 'Republic Day' },
  { month: 3, day: 3, name: 'Holi' },
  { month: 4, day: 3, name: 'Good Friday' },
  { month: 4, day: 20, name: 'Ram Navami' },
  { month: 8, day: 15, name: 'Independence Day' },
  { month: 11, day: 8, name: 'Diwali' },
  { month: 12, day: 25, name: 'Christmas' },
];

async function seedHolidays(): Promise<void> {
  const year = new Date().getFullYear();
  let created = 0;
  let skipped = 0;

  for (const h of SEED_HOLIDAYS) {
    // Use UTC date to match @db.Date storage
    const date = new Date(Date.UTC(year, h.month - 1, h.day));

    const existing = await prisma.holiday.findFirst({
      where: { year, date },
    });

    if (existing) {
      skipped++;
    } else {
      await prisma.holiday.create({
        data: { year, date, name: h.name },
      });
      created++;
      console.log(`  [holiday] Created: ${h.name} (${year}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')})`);
    }
  }

  if (skipped > 0) console.log(`  [holiday] Skipped ${skipped} existing holiday rows.`);
  console.log(`  [holiday] Created ${created} new holiday rows for ${year}.`);
}

async function main(): Promise<void> {
  console.log('Nexora HRMS — Seed starting...\n');

  console.log('Seeding configuration...');
  await seedConfiguration();

  console.log('\nSeeding default admin...');
  await seedAdmin();

  console.log('\nSeeding leave types (Phase 2)...');
  await seedLeaveTypes();

  console.log('\nSeeding leave quotas (Phase 2)...');
  await seedLeaveQuotas();

  console.log('\nSeeding admin leave balances (Phase 2)...');
  await seedAdminLeaveBalances();

  console.log('\nSeeding holiday calendar (Phase 3)...');
  await seedHolidays();

  console.log('\nSeed complete.');
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
