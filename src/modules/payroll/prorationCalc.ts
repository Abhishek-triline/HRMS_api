/**
 * Proration calculator — BL-036.
 *
 * Computes "days actually worked" for pro-rating salary on mid-month joiners/exits.
 *
 * Edge cases documented here:
 *
 * 1. Full-month employee (joined before period start, no exit):
 *    effectiveStart = periodStart, effectiveEnd = periodEnd
 *    daysWorked = workingDays - lopDays
 *
 * 2. Mid-month joiner (joinDate > periodStart, joinDate <= periodEnd):
 *    effectiveStart = joinDate, effectiveEnd = periodEnd
 *    daysWorked = count of Mon–Fri days in [joinDate, periodEnd] - lopDays (capped at 0)
 *    NOTE: holiday-exclusion is NOT applied in this calculation because lopDays
 *    already accounts for approved absences; working-day proration uses raw
 *    weekday count so the "days actually available" is proportional.
 *    v1 simplification: we use calendar-day counting (same as BL-036 text)
 *    then pro-rate: daysWorked = floor(workingDays × calendarDaysInPeriod / totalCalendarDays).
 *    Full formula: daysWorked = round(workingDays × eligibleCalDays / periodCalDays) - lopDays
 *
 * 3. Mid-month exit (exitDate >= periodStart, exitDate < periodEnd):
 *    effectiveEnd = exitDate, effectiveStart = periodStart
 *    Mirror of case 2.
 *
 * 4. Joined AND exited in the same period:
 *    effectiveStart = joinDate, effectiveEnd = exitDate
 *    Must still clamp at 0.
 *
 * 5. LOP days are subtracted AFTER proration so that a short-stay employee
 *    does not end up with negative daysWorked. Floor at 0.
 *
 * The formula used is:
 *   eligibleCalDays = min(periodEnd, exitDate ?? periodEnd) - max(periodStart, joinDate) + 1
 *   totalCalDays    = periodEnd - periodStart + 1
 *   proRatedDays    = round(workingDays × eligibleCalDays / totalCalDays)
 *   daysWorked      = max(0, proRatedDays - lopDays)
 */

/**
 * Input data about the employee — the minimal fields needed for proration.
 */
export interface EmployeeForProration {
  joinDate: Date;
  exitDate: Date | null;
}

/**
 * Compute daysWorked for proration.
 *
 * @param employee    — employee's joinDate and exitDate
 * @param periodStart — first day of the pay period
 * @param periodEnd   — last day of the pay period
 * @param workingDays — total working days in the period (from workingDaysCalc)
 * @param lopDays     — loss-of-pay days this employee has in the period
 * @returns           — integer days actually worked (>= 0)
 */
export function daysWorkedFor(
  employee: EmployeeForProration,
  periodStart: Date,
  periodEnd: Date,
  workingDays: number,
  lopDays: number,
): number {
  const { joinDate, exitDate } = employee;

  // Clamp effective start/end to period boundaries
  const effectiveStart = joinDate > periodStart ? joinDate : periodStart;
  const effectiveEnd =
    exitDate && exitDate < periodEnd ? exitDate : periodEnd;

  // If employee left before the period started, or joined after it ended: 0 days
  if (effectiveStart > effectiveEnd) return 0;

  // Calendar days
  const periodCalDays =
    Math.round((periodEnd.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const eligibleCalDays =
    Math.round((effectiveEnd.getTime() - effectiveStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;

  if (periodCalDays <= 0) return 0;

  // Pro-rate workingDays by proportion of calendar days in period.
  // Round to nearest integer (0.5 rounds up per standard JS Math.round behaviour).
  // Rounding choice: standard 0.5-rounds-up (not banker's rounding). This is
  // simpler and the SRS does not mandate a specific rounding mode.
  const proRated = Math.round(workingDays * eligibleCalDays / periodCalDays);

  // Subtract LOP days, clamp at 0
  return Math.max(0, proRated - lopDays);
}
