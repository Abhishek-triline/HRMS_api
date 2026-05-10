/**
 * Prisma client singleton.
 * Import from here — never instantiate PrismaClient directly in modules.
 */

import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// In development, re-use the instance across hot-reloads to avoid
// exhausting MySQL connection pools.
export const prisma: PrismaClient =
  globalThis.__prisma ??
  new PrismaClient({
    log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env['NODE_ENV'] !== 'production') {
  globalThis.__prisma = prisma;
}
