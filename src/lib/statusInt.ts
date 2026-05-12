/**
 * Backend INT-code constants — single source of truth for every status,
 * type, category, role, and module code used on the wire and in the DB.
 *
 * These constants mirror the FROZEN code mappings in
 * docs/HRMS_Schema_v2_Plan.md §3 and the MySQL column COMMENTs applied by
 * migration 20260512210000_int_code_column_comments.
 *
 * **Never re-number an existing code — only append new ones.**
 * When appending, update all six locations listed in the checklist in
 * `docs/HRMS_Schema_v2_Plan.md` §3.
 */

// ── Master table IDs (FROZEN) ──────────────────────────────────────────────

/** master `roles`. Seed: 1=Employee, 2=Manager, 3=PayrollOfficer, 4=Admin. */
export const RoleId = {
  Employee: 1,
  Manager: 2,
  PayrollOfficer: 3,
  Admin: 4,
} as const;
export type RoleIdValue = (typeof RoleId)[keyof typeof RoleId];

/** master `employment_types`. */
export const EmploymentTypeId = {
  Permanent: 1,
  Contract: 2,
  Probation: 3,
  Intern: 4,
} as const;
export type EmploymentTypeIdValue = (typeof EmploymentTypeId)[keyof typeof EmploymentTypeId];

/** master `genders`. */
export const GenderId = {
  Male: 1,
  Female: 2,
  Other: 3,
  PreferNotToSay: 4,
} as const;
export type GenderIdValue = (typeof GenderId)[keyof typeof GenderId];

/** master `audit_modules`. Used as `audit_log.module_id` FK. */
export const AuditModuleId = {
  auth: 1,
  employees: 2,
  leave: 3,
  payroll: 4,
  attendance: 5,
  performance: 6,
  notifications: 7,
  audit: 8,
  configuration: 9,
} as const;
export type AuditModuleIdValue = (typeof AuditModuleId)[keyof typeof AuditModuleId];

/** master `leave_types`. */
export const LeaveTypeId = {
  Annual: 1,
  Sick: 2,
  Casual: 3,
  Unpaid: 4,
  Maternity: 5,
  Paternity: 6,
} as const;
export type LeaveTypeIdValue = (typeof LeaveTypeId)[keyof typeof LeaveTypeId];

/** Convenience — the four accrual-based leave type IDs (non-event). */
export const ACCRUAL_LEAVE_TYPE_IDS = [
  LeaveTypeId.Annual,
  LeaveTypeId.Sick,
  LeaveTypeId.Casual,
  LeaveTypeId.Unpaid,
] as const;

/** Convenience — Maternity + Paternity. */
export const EVENT_BASED_LEAVE_TYPE_IDS = [
  LeaveTypeId.Maternity,
  LeaveTypeId.Paternity,
] as const;

export const isEventBasedLeaveTypeId = (id: number): boolean =>
  id === LeaveTypeId.Maternity || id === LeaveTypeId.Paternity;

// ── Entity status codes (§3.1–§3.6) ────────────────────────────────────────

/** §3.1 `employees.status`. */
export const EmployeeStatus = {
  Active: 1,
  OnNotice: 2,
  OnLeave: 3,
  Inactive: 4,
  Exited: 5,
} as const;
export type EmployeeStatusValue = (typeof EmployeeStatus)[keyof typeof EmployeeStatus];

/** §3.2 `leave_requests.status`. */
export const LeaveStatus = {
  Pending: 1,
  Approved: 2,
  Rejected: 3,
  Cancelled: 4,
  Escalated: 5,
} as const;
export type LeaveStatusValue = (typeof LeaveStatus)[keyof typeof LeaveStatus];

/** §3.3 `leave_encashments.status`. */
export const LeaveEncashmentStatus = {
  Pending: 1,
  ManagerApproved: 2,
  AdminFinalised: 3,
  Paid: 4,
  Rejected: 5,
  Cancelled: 6,
} as const;
export type LeaveEncashmentStatusValue =
  (typeof LeaveEncashmentStatus)[keyof typeof LeaveEncashmentStatus];

/** §3.4 `attendance_records.status`. */
export const AttendanceStatus = {
  Present: 1,
  Absent: 2,
  OnLeave: 3,
  WeeklyOff: 4,
  Holiday: 5,
} as const;
export type AttendanceStatusValue = (typeof AttendanceStatus)[keyof typeof AttendanceStatus];

/** §3.4 `attendance_records.source_id`. */
export const AttendanceSource = {
  system: 1,
  regularisation: 2,
} as const;
export type AttendanceSourceValue = (typeof AttendanceSource)[keyof typeof AttendanceSource];

/** §3.4 `regularisation_requests.status`. */
export const RegStatus = {
  Pending: 1,
  Approved: 2,
  Rejected: 3,
} as const;
export type RegStatusValue = (typeof RegStatus)[keyof typeof RegStatus];

/** §3.5 `payroll_runs.status` / `payslips.status`. */
export const PayrollRunStatus = {
  Draft: 1,
  Review: 2,
  Finalised: 3,
  Reversed: 4,
} as const;
export type PayrollRunStatusValue =
  (typeof PayrollRunStatus)[keyof typeof PayrollRunStatus];

/** Alias — payslip and payroll-run share the same lifecycle codes. */
export const PayslipStatus = PayrollRunStatus;
export type PayslipStatusValue = PayrollRunStatusValue;

/** §3.6 `performance_cycles.status`. */
export const CycleStatus = {
  Open: 1,
  SelfReview: 2,
  ManagerReview: 3,
  Closed: 4,
} as const;
export type CycleStatusValue = (typeof CycleStatus)[keyof typeof CycleStatus];

/** §3.6 `goals.outcome_id`. */
export const GoalOutcome = {
  Pending: 1,
  Met: 2,
  Partial: 3,
  Missed: 4,
} as const;
export type GoalOutcomeValue = (typeof GoalOutcome)[keyof typeof GoalOutcome];

// ── Routing + reason + source/purpose codes ────────────────────────────────

/** §3.2 / §3.3 / §3.4 `*.routed_to_id`. */
export const RoutedTo = {
  Manager: 1,
  Admin: 2,
} as const;
export type RoutedToValue = (typeof RoutedTo)[keyof typeof RoutedTo];

/** §3.8 `password_reset_tokens.purpose_id`. */
export const TokenPurpose = {
  FirstLogin: 1,
  ResetPassword: 2,
} as const;
export type TokenPurposeValue = (typeof TokenPurpose)[keyof typeof TokenPurpose];

/** §3.8 `reporting_manager_history.reason_id`. */
export const ReportingHistoryReason = {
  Initial: 1,
  Reassigned: 2,
  Exited: 3,
} as const;
export type ReportingHistoryReasonValue =
  (typeof ReportingHistoryReason)[keyof typeof ReportingHistoryReason];

/** §3.2 `leave_balance_ledger.reason_id`. */
export const LedgerReason = {
  Initial: 1,
  Approval: 2,
  Cancellation: 3,
  CarryForward: 4,
  Adjustment: 5,
  LateMarkPenalty: 6,
} as const;
export type LedgerReasonValue = (typeof LedgerReason)[keyof typeof LedgerReason];

/** Internal: §3.2 cancelled_by role tag on `leave_requests`. */
export const CancelledByRole = {
  Self: 1,
  Manager: 2,
  Admin: 3,
} as const;
export type CancelledByRoleValue = (typeof CancelledByRole)[keyof typeof CancelledByRole];

// ── Notification + audit codes (§3.7 / §3.9) ───────────────────────────────

/** §3.7 `notifications.category_id`. */
export const NotificationCategory = {
  Leave: 1,
  Attendance: 2,
  Payroll: 3,
  Performance: 4,
  Status: 5,
  Configuration: 6,
  Auth: 7,
  System: 8,
} as const;
export type NotificationCategoryValue =
  (typeof NotificationCategory)[keyof typeof NotificationCategory];

/** §3.9 `audit_log.target_type_id`. */
export const AuditTargetType = {
  Employee: 1,
  LeaveRequest: 2,
  LeaveEncashment: 3,
  AttendanceRecord: 4,
  RegularisationRequest: 5,
  PayrollRun: 6,
  Payslip: 7,
  PerformanceCycle: 8,
  PerformanceReview: 9,
  Goal: 10,
  Configuration: 11,
  SalaryStructure: 12,
  Holiday: 13,
  Notification: 14,
} as const;
export type AuditTargetTypeValue = (typeof AuditTargetType)[keyof typeof AuditTargetType];

/** §3.9 `audit_log.actor_role_id`. Superset of RoleId with system codes. */
export const AuditActorRole = {
  Employee: 1,
  Manager: 2,
  PayrollOfficer: 3,
  Admin: 4,
  unknown: 99,
  system: 100,
} as const;
export type AuditActorRoleValue = (typeof AuditActorRole)[keyof typeof AuditActorRole];

// ── Master row status (uniform across all master tables) ───────────────────

/** master_table.status: 1=Active, 2=Deprecated. */
export const MasterStatus = {
  Active: 1,
  Deprecated: 2,
} as const;
export type MasterStatusValue = (typeof MasterStatus)[keyof typeof MasterStatus];
