/**
 * Nexora HRMS — Phase 8 Performance Seeder
 * Creates ~250 additional employees with realistic data for p95 latency testing.
 * Run from apps/api/: npx tsx scripts/seed-perf.ts
 *
 * Target mix: ~5 Admin, ~25 Manager, ~210 Employee, ~10 PayrollOfficer
 * Also seeds: 1000 audit_log rows, 500 notifications, closed perf cycle,
 *             attendance records for 50 employees × last 30 days.
 */

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ulid } from 'ulid';
import { generateEmpCode } from '../src/modules/employees/empCode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const prisma = new PrismaClient({ log: ['warn', 'error'] });

const DEPARTMENTS = ['Engineering', 'HR', 'Finance', 'Marketing', 'Operations', 'Design', 'Product', 'Sales'];
const DESIGNATIONS: Record<string, string[]> = {
  Admin: ['HR Manager', 'Head of People'],
  Manager: ['Engineering Lead', 'Team Lead', 'Senior Manager', 'Department Head'],
  Employee: ['Software Engineer', 'Data Analyst', 'Marketing Specialist', 'Designer', 'Operations Associate', 'Accountant'],
  PayrollOfficer: ['Payroll Specialist', 'Finance Officer'],
};

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDate(startYear: number, endYear: number): Date {
  const start = new Date(startYear, 0, 1);
  const end = new Date(endYear, 11, 31);
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

async function main() {
  console.log('=== Phase 8 Performance Seed Starting ===\n');

  const passwordHash = await argon2.hash('PerfTest@123', { type: argon2.argon2id });

  const existingAdmin = await prisma.employee.findFirst({ where: { role: 'Admin', status: 'Active' } });
  if (!existingAdmin) { console.error('No active admin found. Run base seed first.'); process.exit(1); }

  const existingManagers = await prisma.employee.findMany({ where: { role: 'Manager', status: 'Active' }, select: { id: true } });
  const managerIds: string[] = existingManagers.map(m => m.id);

  const leaveTypes = await prisma.leaveType.findMany();
  const annualLT = leaveTypes.find(lt => lt.name === 'Annual');
  const sickLT = leaveTypes.find(lt => lt.name === 'Sick');
  const casualLT = leaveTypes.find(lt => lt.name === 'Casual');

  // ── Phase 1: Create managers (20 new) ────────────────────────────────────────
  const MANAGER_COUNT = 20;
  const ADMIN_COUNT = 3;
  const EMPLOYEE_COUNT = 210;
  const PAYROLL_COUNT = 7;

  async function createOne(
    role: 'Admin' | 'Manager' | 'Employee' | 'PayrollOfficer',
    idx: number,
    mgr: string,
  ) {
    const stamp = `${Date.now()}-${idx}`;
    const email = `perf.${role.toLowerCase()}.${idx}.${stamp}@nexora.perf`.toLowerCase();
    const dept = randomFrom(DEPARTMENTS);
    const desig = randomFrom(DESIGNATIONS[role]!);
    const joinDate = randomDate(2022, 2026);
    const basicPaise = randomBetween(40, 250) * 100000;
    const allowancesPaise = randomBetween(5, 50) * 100000;

    return prisma.$transaction(async (tx) => {
      const code = await generateEmpCode(new Date().getFullYear(), tx);
      const emp = await tx.employee.create({
        data: {
          code, name: `Perf ${role} ${idx}`, email, role,
          department: dept, designation: desig, employmentType: 'Permanent',
          status: 'Active', joinDate, passwordHash, mustResetPassword: false,
          reportingManagerId: mgr,
        },
      });
      await tx.salaryStructure.create({
        data: { employeeId: emp.id, basicPaise, allowancesPaise, effectiveFrom: joinDate, version: 0 },
      });
      await tx.reportingManagerHistory.create({
        data: { employeeId: emp.id, managerId: mgr, fromDate: joinDate, toDate: null, reason: 'Initial' },
      });
      if (annualLT) await tx.leaveBalance.create({
        data: { employeeId: emp.id, leaveTypeId: annualLT.id, year: 2026, daysRemaining: randomBetween(5, 18), daysUsed: randomBetween(0, 5), version: 0 },
      }).catch(() => {});
      if (sickLT) await tx.leaveBalance.create({
        data: { employeeId: emp.id, leaveTypeId: sickLT.id, year: 2026, daysRemaining: randomBetween(5, 10), daysUsed: randomBetween(0, 3), version: 0 },
      }).catch(() => {});
      if (casualLT) await tx.leaveBalance.create({
        data: { employeeId: emp.id, leaveTypeId: casualLT.id, year: 2026, daysRemaining: randomBetween(2, 6), daysUsed: randomBetween(0, 2), version: 0 },
      }).catch(() => {});
      return emp;
    });
  }

  console.log(`Creating ${ADMIN_COUNT} admins + ${MANAGER_COUNT} managers...`);
  for (let i = 0; i < ADMIN_COUNT; i++) {
    try { await createOne('Admin', i, existingAdmin.id); process.stdout.write('.'); }
    catch (e: any) { if (e.code !== 'P2002') console.error(e.message); }
  }
  for (let i = 0; i < MANAGER_COUNT; i++) {
    try {
      const emp = await createOne('Manager', i, existingAdmin.id);
      managerIds.push(emp.id);
      process.stdout.write('.');
    } catch (e: any) { if (e.code !== 'P2002') console.error(e.message); }
  }
  console.log(' done managers.');

  const allManagerIds = managerIds.length > 0 ? managerIds : [existingAdmin.id];

  console.log(`Creating ${EMPLOYEE_COUNT} employees...`);
  for (let i = 0; i < EMPLOYEE_COUNT; i++) {
    try {
      await createOne('Employee', i, randomFrom(allManagerIds));
      if (i % 20 === 0) process.stdout.write('.');
    } catch (e: any) { if (e.code !== 'P2002') { /* skip */ } }
  }
  console.log(' done employees.');

  console.log(`Creating ${PAYROLL_COUNT} payroll officers...`);
  for (let i = 0; i < PAYROLL_COUNT; i++) {
    try { await createOne('PayrollOfficer', i, existingAdmin.id); process.stdout.write('.'); }
    catch (e: any) { if (e.code !== 'P2002') { /* skip */ } }
  }
  console.log(' done payroll officers.');

  // ── Phase 2: Bulk audit log (1000 rows) ──────────────────────────────────────
  console.log('\nCreating 1000 audit log entries...');
  const allEmps = await prisma.employee.findMany({ select: { id: true } });
  const auditActions = ['leave.approved', 'leave.rejected', 'attendance.regularised', 'employee.created', 'payroll.finalised', 'auth.login.success', 'config.updated', 'performance.cycle.closed'];
  const auditModules = ['leave', 'attendance', 'employees', 'payroll', 'auth', 'configuration', 'performance'];
  const auditBatch = Array.from({ length: 1000 }, (_, i) => ({
    id: ulid(),
    actorId: randomFrom(allEmps).id,
    actorRole: 'Employee',
    actorIp: '127.0.0.1',
    action: randomFrom(auditActions),
    module: randomFrom(auditModules),
    targetType: 'leave_request',
    targetId: `perf-target-${i}`,
    before: { status: 'Pending' } as any,
    after: { status: 'Approved' } as any,
  }));
  await prisma.auditLog.createMany({ data: auditBatch });
  console.log('Done audit logs.');

  // ── Phase 3: 500 notifications ───────────────────────────────────────────────
  console.log('Creating 500 notifications...');
  const categories = ['Leave', 'Payroll', 'Performance', 'Attendance', 'System'] as const;
  const notifBatch = Array.from({ length: 500 }, (_, i) => ({
    recipientId: randomFrom(allEmps).id,
    category: randomFrom(categories) as any,
    title: `Perf Test Notification ${i}`,
    body: `Performance test notification body ${i}. This notification was created for load testing the HRMS platform.`,
    link: `/leave/${i}`,
    unread: Math.random() > 0.4,
    auditLogId: null,
  }));
  await prisma.notification.createMany({ data: notifBatch });
  console.log('Done notifications.');

  // ── Phase 4: Closed performance cycle ────────────────────────────────────────
  console.log('Creating closed performance cycle...');
  const existingCycle = await prisma.performanceCycle.findFirst({ where: { code: 'C-2026-H1-PERF' } });
  if (!existingCycle) {
    const cycle = await prisma.performanceCycle.create({
      data: {
        code: 'C-2026-H1-PERF',
        fyStart: new Date('2026-04-01'),
        fyEnd: new Date('2026-09-30'),
        status: 'Closed',
        selfReviewDeadline: new Date('2026-08-31'),
        managerReviewDeadline: new Date('2026-09-15'),
        closedAt: new Date(),
        closedBy: existingAdmin.id,
        createdBy: existingAdmin.id,
        participants: 30,
      },
    });
    const reviewEmps = allEmps.slice(0, 30);
    for (const emp of reviewEmps) {
      await prisma.performanceReview.create({
        data: {
          cycleId: cycle.id,
          employeeId: emp.id,
          managerId: existingAdmin.id,
          selfRating: randomBetween(1, 5),
          selfNote: 'Good performance this cycle',
          managerRating: randomBetween(1, 5),
          managerNote: 'Strong contributor',
          finalRating: randomBetween(1, 5),
          lockedAt: new Date(),
          status: 'Closed',
        },
      }).catch(() => {});
    }
    console.log('Done performance cycle + 30 reviews.');
  } else {
    console.log('Cycle C-2026-H1-PERF already exists, skipping.');
  }

  // ── Phase 5: Attendance records ──────────────────────────────────────────────
  console.log('Creating attendance records (50 emps × 30 days)...');
  const first50 = allEmps.slice(0, 50);
  const now = new Date();
  let attCreated = 0;
  for (let d = 30; d >= 1; d--) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    date.setHours(0, 0, 0, 0);
    const dow = date.getDay();
    const isWeekend = dow === 0 || dow === 6;
    for (const emp of first50) {
      const isLate = !isWeekend && Math.random() < 0.1;
      const absent = !isWeekend && Math.random() < 0.12;
      const status = isWeekend ? 'WeeklyOff' : absent ? 'Absent' : 'Present';
      try {
        await prisma.attendanceRecord.upsert({
          where: { employeeId_date_source: { employeeId: emp.id, date, source: 'system' } },
          create: {
            employeeId: emp.id, date, status: status as any, source: 'system',
            checkInTime: status === 'Present' ? new Date(date.getTime() + (isLate ? 10.6 : randomBetween(8, 10)) * 3600000) : null,
            checkOutTime: status === 'Present' ? new Date(date.getTime() + randomBetween(17, 20) * 3600000) : null,
            hoursWorkedMinutes: status === 'Present' ? randomBetween(7, 10) * 60 : null,
            late: isLate && !absent, lateMonthCount: 0, lopApplied: false,
          },
          update: {},
        });
        attCreated++;
      } catch { /* skip */ }
    }
  }
  console.log(`Done attendance: ${attCreated} records.`);

  const finalCount = await prisma.employee.count({ where: { status: 'Active' } });
  const auditTotal = await prisma.auditLog.count();
  const notifTotal = await prisma.notification.count();
  console.log(`\n=== Seeding Complete ===`);
  console.log(`Active employees: ${finalCount}`);
  console.log(`Total audit logs: ${auditTotal}`);
  console.log(`Total notifications: ${notifTotal}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
