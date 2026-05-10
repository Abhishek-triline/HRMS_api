/**
 * Nexora HRMS — Database seed (Phase 0)
 *
 * Idempotent: safe to run multiple times.
 * Creates:
 *   1. Configuration rows (all Phase-0 configurable defaults)
 *   2. Default admin employee — admin@triline.in / admin@123
 *      code EMP-2024-0001, mustResetPassword=false
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
];

// ── Admin defaults (override via env) ────────────────────────────────────────

const ADMIN_EMAIL = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@triline.in';
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
    console.log(`  [admin] Already exists (${ADMIN_EMAIL}) — skipping.`);
    return;
  }

  const passwordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id });

  await prisma.employee.create({
    data: {
      code: 'EMP-2024-0001',
      email: ADMIN_EMAIL,
      name: 'Priya Sharma',
      passwordHash,
      role: 'Admin',
      status: 'Active',
      department: 'HR',
      designation: 'Head of People',
      reportingManagerId: null,
      joinDate: new Date('2024-01-01'),
      exitDate: null,
      mustResetPassword: false,
      version: 0,
    },
  });

  console.log(`  [admin] Created admin employee: ${ADMIN_EMAIL}`);
  console.log(`  [admin] Code: EMP-2024-0001, Name: Priya Sharma`);
  console.log(`  [admin] IMPORTANT: Change the password immediately in production.`);
}

async function main(): Promise<void> {
  console.log('Nexora HRMS — Seed starting...\n');

  console.log('Seeding configuration...');
  await seedConfiguration();

  console.log('\nSeeding default admin...');
  await seedAdmin();

  console.log('\nSeed complete.');
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
