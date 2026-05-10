-- Phase 7: Audit Log performance indexes.
-- Applied once by Prisma's migration runner (idempotency guaranteed by the
-- _prisma_migrations lock table — no IF NOT EXISTS needed).
-- Uses camelCase column names matching Prisma's default MySQL mapping.

-- Compound index for the keyset cursor query (default sort: createdAt DESC, id DESC).
-- Covers both the primary listing and the cursor-comparison predicate.
CREATE INDEX idx_audit_log_created_at_id
  ON audit_log (createdAt DESC, id DESC);

-- Per-module filter (most common Admin drill-down: module + time range).
CREATE INDEX idx_audit_log_module_created_at
  ON audit_log (module, createdAt DESC);

-- Actor + time — for filtering a specific employee's actions.
CREATE INDEX idx_audit_log_actor_created_at
  ON audit_log (actorId, createdAt DESC);
