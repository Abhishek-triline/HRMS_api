/**
 * Holiday and weekly-off helpers — Phase 3 (config-aware as of Phase 7).
 *
 * isHoliday: queries the Holiday table for the given date.
 * isWeeklyOff: returns true if the date falls on a weekday listed in the
 *   live AttendanceConfig.weeklyOffDays array. Defaults to Sat/Sun when no
 *   override is configured. This replaces the previous hard-coded Sat/Sun
 *   check so Admin can adjust the working-week via /admin/configuration.
 */

import type { Prisma } from '@prisma/client';
import { getAttendanceConfig, weekdayTokenFromIndex } from '../../lib/config.js';

/**
 * Returns the holiday record if `date` is a public holiday, null otherwise.
 * Uses the Holiday table seeded/replaced via PUT /config/holidays.
 */
export async function isHoliday(
  date: Date,
  tx: Prisma.TransactionClient,
): Promise<{ id: number; name: string } | null> {
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
 * Returns true if `date` falls on a configured weekly-off day.
 *
 * The set of weekly-off days is read from AttendanceConfig.weeklyOffDays
 * (live config, 30 s cache). Default is ['Sat', 'Sun'] — matches the Indian
 * 5-day work-week. The weekday is derived from the UTC date value because
 * attendance dates are stored as @db.Date (UTC midnight) in the DB.
 *
 * Note: this is now async (was sync). The change is transparent to
 * deriveStatusForDay/runMidnightGenerate since both already run inside an
 * async transaction.
 */
export async function isWeeklyOff(date: Date): Promise<boolean> {
  const { weeklyOffDays } = await getAttendanceConfig();
  if (weeklyOffDays.length === 0) return false;
  const token = weekdayTokenFromIndex(date.getUTCDay());
  return weeklyOffDays.includes(token);
}
