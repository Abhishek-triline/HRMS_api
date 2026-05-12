/**
 * Notification helper.
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
 * v2: recipient IDs are INT employee ids. Categories are INT codes
 * (HRMS_Schema_v2_Plan §3.7). For ergonomics this helper accepts the friendly
 * category name (`'Leave'`, `'Payroll'`, ...) and maps it via the frozen
 * constants in `./statusInt.ts`.
 */

import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from './prisma.js';
import { logger } from './logger.js';
import {
  NotificationCategory,
  type NotificationCategoryValue,
} from './statusInt.js';

export interface NotifyParams {
  /** Pass the current Prisma transaction client to roll back on failure. */
  tx?: Prisma.TransactionClient;
  /** One or many recipient employee IDs (INT). Fan-out via createMany. */
  recipientIds: number | number[];
  /** Friendly category name OR the INT code. */
  category: keyof typeof NotificationCategory | NotificationCategoryValue;
  /** ≤ 120 chars — truncated silently if the caller passes more. */
  title: string;
  /** ≤ 600 chars — truncated silently. Plain text only (BL-046). */
  body: string;
  /** Deep link to the originating record, e.g. /employee/leave/L-2026-0001 */
  link?: string | null;
  /** Reference to the audit_log row that produced this notification. */
  auditLogId?: number | null;
}

function resolveCategory(
  v: NotifyParams['category'],
): NotificationCategoryValue {
  return typeof v === 'number' ? v : NotificationCategory[v];
}

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

  const unique = Array.from(new Set(recipients.filter((id): id is number => Number.isInteger(id) && id > 0)));
  if (unique.length === 0) return;

  // SEC-001-P6: Defence-in-depth — sanitize link even if caller skips contract validation.
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

  const categoryId = resolveCategory(params.category);

  try {
    await db.notification.createMany({
      data: unique.map((recipientId) => ({
        recipientId,
        categoryId,
        title: params.title.slice(0, 120),
        body: params.body.slice(0, 600),
        link: safeLink,
        auditLogId: params.auditLogId ?? null,
      })),
    });
  } catch (err: unknown) {
    // BL-047 / BL-043: notifications are derived data. A write failure here
    // is logged but NEVER re-thrown.
    logger.error(
      { err, recipientCount: unique.length, category: params.category },
      'notify.error — notification write failed; business action continues',
    );
  }
}
