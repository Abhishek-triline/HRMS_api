/**
 * Holiday and weekly-off helpers — Phase 3.
 *
 * isHoliday: queries the Holiday table for the given date.
 * isWeeklyOff: Saturday (6) or Sunday (0) per v1 design.
 *   - Design note (DN-weeklyoff): weekly-off days are Sat/Sun for all
 *     employees in v1. A future phase may make this configurable per
 *     department or shift. This is consistent with DN-06 (no half-days).
 */

import type { Prisma } from '@prisma/client';

/**
 * Returns the holiday record if `date` is a public holiday, null otherwise.
 * Uses the Holiday table seeded/replaced via PUT /config/holidays.
 */
export async function isHoliday(
  date: Date,
  tx: Prisma.TransactionClient,
): Promise<{ id: string; name: string } | null> {
  // Normalise to midnight UTC for DB comparison with @db.Date columns.
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const holiday = await tx.holiday.findFirst({
    where: {
      date: {
        gte: dayStart,
        lte: dayEnd,
      },
    },
    select: { id: true, name: true },
  });

  return holiday ?? null;
}

/**
 * Returns true if `date` falls on a Saturday or Sunday.
 *
 * Design note: weekly-off days are Saturday (6) and Sunday (0) for v1.
 * This matches the Indian 5-day work-week standard. The weekday is
 * derived from the UTC date value because attendance dates are stored
 * as @db.Date (UTC midnight) in the DB.
 */
export function isWeeklyOff(date: Date): boolean {
  const day = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}
