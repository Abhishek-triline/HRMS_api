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
import type { AttendanceConfig, LeaveConfig, CarryForwardCaps } from '@nexora/contracts/configuration';

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

/** Defaults (BL-027 / Phase 3). */
const ATTENDANCE_DEFAULTS: AttendanceConfig = {
  lateThresholdTime: '10:30',
  standardDailyHours: 8,
};

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

  // Read both keys in parallel
  const [thresholdVal, hoursVal, legacyThresholdVal] = await Promise.all([
    readConfigKey('ATTENDANCE_LATE_THRESHOLD_TIME'),
    readConfigKey('ATTENDANCE_STANDARD_DAILY_HOURS'),
    readConfigKey('LATE_THRESHOLD'), // legacy Phase-3 alias
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

  const result: AttendanceConfig = { lateThresholdTime, standardDailyHours };
  cacheSet(CACHE_KEY, result);
  return result;
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
