/**
 * Working-days helpers — Phase 2.
 *
 * Phase 2 uses a simple Mon–Fri rule (skip Sat/Sun).
 *
 * TODO(Phase 3): integrate the Holiday calendar from the `holidays` table
 * so that public holidays are also excluded from working-day counts.
 */

/**
 * Return true if the given date falls on a weekday (Mon–Fri).
 */
function isWeekday(d: Date): boolean {
  const day = d.getDay(); // 0=Sun, 6=Sat
  return day !== 0 && day !== 6;
}

/**
 * Count the number of working days (Mon–Fri) from `a` to `b` inclusive.
 * Both arguments should be date-only values (time is ignored).
 *
 * Returns 0 if `a > b`.
 */
export function workingDaysBetween(a: Date, b: Date): number {
  if (a > b) return 0;

  let count = 0;
  const cursor = new Date(a);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(b);
  end.setHours(0, 0, 0, 0);

  while (cursor <= end) {
    if (isWeekday(cursor)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }

  return count;
}

/**
 * Advance `start` by `n` working days (Mon–Fri) and return the result.
 * `n` must be >= 0.
 */
export function addWorkingDays(start: Date, n: number): Date {
  const result = new Date(start);
  result.setHours(0, 0, 0, 0);

  let remaining = n;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    if (isWeekday(result)) remaining--;
  }

  return result;
}
