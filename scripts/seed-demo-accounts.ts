/**
 * Seeds the three demo accounts that the login page's role chips expect:
 *   manager@triline.co.in, employee@triline.co.in, payroll@triline.co.in (all admin@123).
 *
 * Idempotent — re-running skips accounts that already exist.
 */
import argon2 from 'argon2';
import { PrismaClient, type Role, type EmploymentType } from '@prisma/client';

const prisma = new PrismaClient();

const PASSWORD = 'admin@123';

const DEMO_USERS: Array<{
  email: string;
  name: string;
  role: Role;
  code: string;
  designation: string;
  department: string;
  employmentType: EmploymentType;
  reportsToEmail: string | null;
}> = [
  {
    email: 'manager@triline.co.in',
    name: 'Arjun Mehta',
    role: 'Manager',
    code: 'EMP-2024-0002',
    designation: 'Engineering Manager',
    department: 'Engineering',
    employmentType: 'Permanent',
    reportsToEmail: 'admin@triline.co.in',
  },
  {
    email: 'employee@triline.co.in',
    name: 'Kavya Reddy',
    role: 'Employee',
    code: 'EMP-2024-0003',
    designation: 'Software Engineer',
    department: 'Engineering',
    employmentType: 'Permanent',
    reportsToEmail: 'manager@triline.co.in',
  },
  {
    email: 'payroll@triline.co.in',
    name: 'Ravi Iyer',
    role: 'PayrollOfficer',
    code: 'EMP-2024-0004',
    designation: 'Payroll Officer',
    department: 'Finance',
    employmentType: 'Permanent',
    reportsToEmail: 'admin@triline.co.in',
  },
];

async function main() {
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const joinDate = new Date('2024-02-01');

  for (const u of DEMO_USERS) {
    const existing = await prisma.employee.findUnique({ where: { email: u.email } });
    if (existing) {
      console.log(`[skip] ${u.email} already exists`);
      continue;
    }

    const managerId = u.reportsToEmail
      ? (await prisma.employee.findUnique({ where: { email: u.reportsToEmail } }))?.id ?? null
      : null;

    const employee = await prisma.employee.create({
      data: {
        code: u.code,
        email: u.email,
        name: u.name,
        passwordHash,
        role: u.role,
        status: 'Active',
        employmentType: u.employmentType,
        department: u.department,
        designation: u.designation,
        reportingManagerId: managerId,
        joinDate,
        exitDate: null,
        mustResetPassword: false,
        version: 0,
      },
    });

    await prisma.salaryStructure.create({
      data: {
        employeeId: employee.id,
        basicPaise: 5000000, // ₹50,000 default
        allowancesPaise: 1500000,
        effectiveFrom: joinDate,
        version: 0,
      },
    });

    await prisma.reportingManagerHistory.create({
      data: {
        employeeId: employee.id,
        managerId,
        fromDate: joinDate,
        toDate: null,
        reason: 'Initial',
      },
    });

    console.log(`[ok] created ${u.email} (${u.role})`);
  }

  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
