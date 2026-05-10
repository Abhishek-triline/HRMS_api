/**
 * Notification helper — Phase 6.
 *
 * BL-043: Notifications are system-generated only. EVERY qualifying business
 *         event calls this helper — there is no public POST endpoint.
 * BL-044: Recipients are always scoped by the calling site. This helper
 *         accepts an explicit `recipientIds` list — callers are responsible
 *         for scoping correctly (employee-only, admin-only, etc.).
 * BL-046: In-app only. No email, SMS, or push channels.
 * BL-047: A notification failure MUST NEVER break the underlying business
 *         action. Errors are caught, logged, and swallowed. The audit_log
 *         row is the canonical source of truth.
 *
 * Usage (always AFTER the audit() call, inside the same transaction):
 *
 *   await audit({ tx, ...auditParams });   // existing — do NOT touch
 *   await notify({                          // NEW
 *     tx,
 *     recipientIds: [employeeId],
 *     category: 'Leave',
 *     title: 'Your leave request was approved',
 *     body: `${type} leave for ${days} day(s) was approved by ${approverName}.`,
 *     link: `/employee/leave/${id}`,
 *   });
 */

import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from './prisma.js';
import { logger } from './logger.js';
import type { NotificationCategory } from '@nexora/contracts/notifications';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NotifyParams {
  /** Pass the current Prisma transaction client to roll back on failure. */
  tx?: Prisma.TransactionClient;
  /** One or many recipient employee IDs. Fan-out via createMany. */
  recipientIds: string | string[];
  category: NotificationCategory;
  /** ≤ 120 chars — truncated silently if the caller passes more. */
  title: string;
  /** ≤ 600 chars — truncated silently. Plain text only (BL-046). */
  body: string;
  /** Deep link to the originating record, e.g. /employee/leave/L-2026-0001 */
  link?: string | null;
  /** Reference to the audit_log row that produced this notification. */
  auditLogId?: string | null;
}

// ── Category mapping ──────────────────────────────────────────────────────────

/**
 * Map the contract NotificationCategory (used everywhere in application code)
 * to the DB enum value (NotificationCategoryDb). They are identical in this
 * version but this boundary helper makes future divergence safe.
 */
function mapCategoryToDB(
  cat: NotificationCategory,
): 'Leave' | 'Attendance' | 'Payroll' | 'Performance' | 'Status' | 'Configuration' | 'Auth' | 'System' {
  const map: Record<
    NotificationCategory,
    'Leave' | 'Attendance' | 'Payroll' | 'Performance' | 'Status' | 'Configuration' | 'Auth' | 'System'
  > = {
    Leave: 'Leave',
    Attendance: 'Attendance',
    Payroll: 'Payroll',
    Performance: 'Performance',
    Status: 'Status',
    Configuration: 'Configuration',
    Auth: 'Auth',
    System: 'System',
  };
  return map[cat];
}

// ── Core helper ───────────────────────────────────────────────────────────────

/**
 * Create in-app notifications for one or many recipients.
 *
 * Guarantees:
 *   - Deduplicates recipient IDs defensively.
 *   - Truncates title to 120 chars and body to 600 chars.
 *   - Uses createMany for efficient fan-out.
 *   - Catches and swallows ALL errors (BL-047 / BL-043): a notification
 *     failure MUST NEVER break the calling business action.
 */
export async function notify(params: NotifyParams): Promise<void> {
  const db = params.tx ?? defaultPrisma;

  const recipients = Array.isArray(params.recipientIds)
    ? params.recipientIds
    : [params.recipientIds];

  if (recipients.length === 0) return;

  // Defensive de-duplicate
  const unique = Array.from(new Set(recipients.filter(Boolean)));
  if (unique.length === 0) return;

  // SEC-001-P6: Defence-in-depth — sanitize link even if caller skips contract validation.
  // A link that doesn't start with '/' (absolute URL, protocol-relative, javascript:, etc.)
  // is nulled out and a warning is emitted. Truncate to 191 chars for symmetry with
  // title/body limits (also covers SEC-008-P6 Info).
  let safeLink: string | null = params.link ?? null;
  if (safeLink !== null) {
    if (!/^\//.test(safeLink)) {
      logger.warn(
        { link: safeLink, category: params.category },
        'notify: link does not start with / — nulled for safety (SEC-001-P6)',
      );
      safeLink = null;
    } else {
      safeLink = safeLink.slice(0, 191);
    }
  }

  try {
    await db.notification.createMany({
      data: unique.map((recipientId) => ({
        recipientId,
        category: mapCategoryToDB(params.category),
        title: params.title.slice(0, 120),
        body: params.body.slice(0, 600),
        link: safeLink,
        auditLogId: params.auditLogId ?? null,
      })),
      // createMany with skipDuplicates is intentionally NOT set — every event
      // should create its own notification row.
    });
  } catch (err: unknown) {
    // BL-047 / BL-043: notifications are derived data. A write failure here
    // is logged but NEVER re-thrown. The audit_log row is the source of truth.
    logger.error(
      { err, recipientCount: unique.length, category: params.category },
      'notify.error — notification write failed; business action continues',
    );
  }
}
