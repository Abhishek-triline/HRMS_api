-- Migration: employee_personal_and_salary_breakdown
-- Adds optional personal information columns to `employees` and optional
-- allowance component breakdown columns to `salary_structures`.
-- All new columns are nullable so existing rows are completely unaffected.

-- ── employees table: personal information columns ────────────────────────────

ALTER TABLE `employees`
  ADD COLUMN `phone`       VARCHAR(20)  NULL,
  ADD COLUMN `dateOfBirth` DATE         NULL,
  ADD COLUMN `gender`      VARCHAR(20)  NULL;

-- ── salary_structures table: allowance breakdown columns ─────────────────────

ALTER TABLE `salary_structures`
  ADD COLUMN `hraPaise`       INT NULL,
  ADD COLUMN `transportPaise` INT NULL,
  ADD COLUMN `otherPaise`     INT NULL;
