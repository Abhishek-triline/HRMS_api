/**
 * Live-config helpers — Phase 7.
 *
 * Reads typed configuration buckets from the `configuration` table and caches
 * results for 30 seconds to avoid per-request DB hits.
 *
 * Keys used:
 *   ATTENDANCE_LATE_THRESHOLD_TIME   — "HH:MM"  (default "10:30")
 *   ATTENDANCE_STANDARD_DAILY_HOURS  — number    (default 8)
 *   LEAVE_CARRY_FORWARD_CAPS         — Record<LeaveType, number>
 *   LEAVE_ESCALATION_PERIOD_DAYS     — number    (default 5)
 *   LEAVE_MATERNITY_DAYS             — number    (default 182)
 *   LEAVE_PATERNITY_DAYS             — number    (default 10)
 *
 * The older Phase-3 key "LATE_THRESHOLD" is kept as a fallback alias so
 * any pre-existing configuration rows still work seamlessly.
 *
 * Caching strategy: simple in-process Map<string, { value; expiresAt }>.
 * TTL = 30 s. On cache miss the row is fetched from the DB.
 * Two concurrent misses on the same key both fetch from DB (no stampede
 * lock is needed at this scale — the worst case is two identical reads
 * that both populate the same cache slot, which is safe).
 */

import { prisma } from './prisma.js';
import type {
  AttendanceConfig,
  CarryForwardCaps,
  LeaveConfig,
  EncashmentConfig,
  Weekday,
} from '@nexora/contracts/configuration';

const WEEKDAY_TOKENS: readonly Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_TOKEN_SET: ReadonlySet<string> = new Set(WEEKDAY_TOKENS);

// ── Simple TTL cache ──────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number; // Date.now() ms
}

const CONFIG_CACHE_TTL_MS = 30_000; // 30 seconds

const cache = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string): T | undefined {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet<T>(key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
}

/** Bust the entire cache — called after a PUT /config/* succeeds. */
export function bustConfigCache(): void {
  cache.clear();
}

// ── Raw DB read helper ────────────────────────────────────────────────────────

async function readConfigKey(key: string): Promise<unknown | null> {
  const row = await prisma.configuration.findUnique({ where: { key } });
  return row ? row.value : null;
}

// ── Attendance config ─────────────────────────────────────────────────────────

/** Defaults (BL-027 / Phase 3 + Indian 5-day work-week). */
const ATTENDANCE_DEFAULTS: AttendanceConfig = {
  lateThresholdTime: '10:30',
  standardDailyHours: 8,
  weeklyOffDays: ['Sat', 'Sun'],
};

/**
 * Parse a persisted JSON value into a deduplicated, canonical-order Weekday[].
 * Unknown tokens are dropped silently. Returns null if the value is not an array.
 */
function parseWeeklyOffDays(value: unknown): Weekday[] | null {
  if (!Array.isArray(value)) return null;
  const found = new Set<Weekday>();
  for (const item of value) {
    if (typeof item === 'string' && WEEKDAY_TOKEN_SET.has(item)) {
      found.add(item as Weekday);
    }
  }
  // Return in canonical Mon→Sun order so callers can rely on stable ordering.
  return WEEKDAY_TOKENS.filter((d) => found.has(d));
}

/**
 * Returns the current attendance configuration.
 * Reads keys ATTENDANCE_LATE_THRESHOLD_TIME and ATTENDANCE_STANDARD_DAILY_HOURS
 * from the configuration table, falling back to the Phase-3 legacy key
 * LATE_THRESHOLD for lateThresholdTime when the new key is absent.
 *
 * Results are cached for 30 seconds.
 */
export async function getAttendanceConfig(): Promise<AttendanceConfig> {
  const CACHE_KEY = 'bucket:attendance';
  const cached = cacheGet<AttendanceConfig>(CACHE_KEY);
  if (cached) return cached;

  // Read all keys in parallel
  const [thresholdVal, hoursVal, legacyThresholdVal, weeklyOffVal] = await Promise.all([
    readConfigKey('ATTENDANCE_LATE_THRESHOLD_TIME'),
    readConfigKey('ATTENDANCE_STANDARD_DAILY_HOURS'),
    readConfigKey('LATE_THRESHOLD'), // legacy Phase-3 alias
    readConfigKey('ATTENDANCE_WEEKLY_OFF_DAYS'),
  ]);

  // Resolve lateThresholdTime: prefer new key, fall back to legacy, then default
  let lateThresholdTime = ATTENDANCE_DEFAULTS.lateThresholdTime;
  if (typeof thresholdVal === 'string' && /^\d{2}:\d{2}$/.test(thresholdVal)) {
    lateThresholdTime = thresholdVal;
  } else if (typeof legacyThresholdVal === 'string' && /^\d{2}:\d{2}$/.test(legacyThresholdVal)) {
    lateThresholdTime = legacyThresholdVal;
  }

  // Resolve standardDailyHours
  let standardDailyHours = ATTENDANCE_DEFAULTS.standardDailyHours;
  if (typeof hoursVal === 'number' && Number.isFinite(hoursVal) && hoursVal >= 1 && hoursVal <= 24) {
    standardDailyHours = Math.round(hoursVal);
  }

  // Resolve weeklyOffDays — fall back to default Sat/Sun if absent/invalid.
  // An explicitly persisted EMPTY array is honoured (some orgs may run a 7-day
  // operation); only a missing/non-array value triggers the default.
  const parsedWeeklyOff = parseWeeklyOffDays(weeklyOffVal);
  const weeklyOffDays: Weekday[] = parsedWeeklyOff ?? [...ATTENDANCE_DEFAULTS.weeklyOffDays];

  const result: AttendanceConfig = { lateThresholdTime, standardDailyHours, weeklyOffDays };
  cacheSet(CACHE_KEY, result);
  return result;
}

/**
 * Map a JS Date.getUTCDay() / getDay() index (0=Sun..6=Sat) to a Weekday token.
 * Exported so attendance / leave helpers share the same mapping.
 */
export function weekdayTokenFromIndex(dayIndex: number): Weekday {
  // JS: 0=Sun, 1=Mon, … 6=Sat. Map to our canonical Mon-first token list.
  const map: Record<number, Weekday> = {
    0: 'Sun',
    1: 'Mon',
    2: 'Tue',
    3: 'Wed',
    4: 'Thu',
    5: 'Fri',
    6: 'Sat',
  };
  const token = map[dayIndex];
  if (!token) throw new Error(`weekdayTokenFromIndex: invalid index ${dayIndex}`);
  return token;
}

// ── Leave config ──────────────────────────────────────────────────────────────

/** Defaults (Phase 2 hard-coded constants). */
const DEFAULT_CARRY_FORWARD_CAPS: CarryForwardCaps = {
  Annual: 10,
  Sick: 0,
  Casual: 5,
  Unpaid: 0,
  Maternity: 0,
  Paternity: 0,
};

const LEAVE_DEFAULTS: LeaveConfig = {
  carryForwardCaps: DEFAULT_CARRY_FORWARD_CAPS,
  escalationPeriodDays: 5,
  maternityDays: 182,
  paternityDays: 10,
};

/**
 * Returns the current leave configuration.
 * Reads keys LEAVE_CARRY_FORWARD_CAPS, LEAVE_ESCALATION_PERIOD_DAYS,
 * LEAVE_MATERNITY_DAYS, and LEAVE_PATERNITY_DAYS from the configuration table.
 *
 * Results are cached for 30 seconds.
 */
export async function getLeaveConfig(): Promise<LeaveConfig> {
  const CACHE_KEY = 'bucket:leave';
  const cached = cacheGet<LeaveConfig>(CACHE_KEY);
  if (cached) return cached;

  const [capsVal, escalationVal, maternityVal, paternityVal] = await Promise.all([
    readConfigKey('LEAVE_CARRY_FORWARD_CAPS'),
    readConfigKey('LEAVE_ESCALATION_PERIOD_DAYS'),
    readConfigKey('LEAVE_MATERNITY_DAYS'),
    readConfigKey('LEAVE_PATERNITY_DAYS'),
  ]);

  // carryForwardCaps: merge DB value over defaults
  let carryForwardCaps: CarryForwardCaps = { ...DEFAULT_CARRY_FORWARD_CAPS };
  if (capsVal !== null && typeof capsVal === 'object' && !Array.isArray(capsVal)) {
    const raw = capsVal as Record<string, unknown>;
    carryForwardCaps = {
      Annual:    typeof raw['Annual']    === 'number' ? raw['Annual']    : DEFAULT_CARRY_FORWARD_CAPS.Annual,
      Sick:      0, // BL-012 — always 0
      Casual:    typeof raw['Casual']    === 'number' ? raw['Casual']    : DEFAULT_CARRY_FORWARD_CAPS.Casual,
      Unpaid:    0,
      Maternity: 0, // BL-014 — event-based
      Paternity: 0, // BL-014 — event-based
    };
  }

  const escalationPeriodDays =
    typeof escalationVal === 'number' &&
    Number.isFinite(escalationVal) &&
    escalationVal >= 1 &&
    escalationVal <= 30
      ? Math.round(escalationVal)
      : LEAVE_DEFAULTS.escalationPeriodDays;

  const maternityDays =
    typeof maternityVal === 'number' && Number.isFinite(maternityVal) && maternityVal >= 1
      ? Math.round(maternityVal)
      : LEAVE_DEFAULTS.maternityDays;

  const paternityDays =
    typeof paternityVal === 'number' && Number.isFinite(paternityVal) && paternityVal >= 1
      ? Math.round(paternityVal)
      : LEAVE_DEFAULTS.paternityDays;

  const result: LeaveConfig = {
    carryForwardCaps,
    escalationPeriodDays,
    maternityDays,
    paternityDays,
  };

  cacheSet(CACHE_KEY, result);
  return result;
}

// ── Encashment config ─────────────────────────────────────────────────────────

/** Defaults (BL-LE-04). */
const ENCASHMENT_DEFAULTS: EncashmentConfig = {
  windowStartMonth: 12,
  windowEndMonth: 1,
  windowEndDay: 15,
  maxPercent: 50,
};

/**
 * Returns the current encashment window configuration.
 * Reads ENCASHMENT_WINDOW_START_MONTH, _END_MONTH, _END_DAY, and
 * ENCASHMENT_MAX_PERCENT from the configuration table.
 * Results are cached for 30 seconds.
 */
export async function getEncashmentConfig(): Promise<EncashmentConfig> {
  const CACHE_KEY = 'bucket:encashment';
  const cached = cacheGet<EncashmentConfig>(CACHE_KEY);
  if (cached) return cached;

  const [startMonthVal, endMonthVal, endDayVal, maxPctVal] = await Promise.all([
    readConfigKey('ENCASHMENT_WINDOW_START_MONTH'),
    readConfigKey('ENCASHMENT_WINDOW_END_MONTH'),
    readConfigKey('ENCASHMENT_WINDOW_END_DAY'),
    readConfigKey('ENCASHMENT_MAX_PERCENT'),
  ]);

  const windowStartMonth =
    typeof startMonthVal === 'number' && startMonthVal >= 1 && startMonthVal <= 12
      ? Math.round(startMonthVal)
      : ENCASHMENT_DEFAULTS.windowStartMonth;

  const windowEndMonth =
    typeof endMonthVal === 'number' && endMonthVal >= 1 && endMonthVal <= 12
      ? Math.round(endMonthVal)
      : ENCASHMENT_DEFAULTS.windowEndMonth;

  const windowEndDay =
    typeof endDayVal === 'number' && endDayVal >= 1 && endDayVal <= 31
      ? Math.round(endDayVal)
      : ENCASHMENT_DEFAULTS.windowEndDay;

  const maxPercent =
    typeof maxPctVal === 'number' && maxPctVal >= 1 && maxPctVal <= 100
      ? Math.round(maxPctVal)
      : ENCASHMENT_DEFAULTS.maxPercent;

  const result: EncashmentConfig = { windowStartMonth, windowEndMonth, windowEndDay, maxPercent };
  cacheSet(CACHE_KEY, result);
  return result;
}
