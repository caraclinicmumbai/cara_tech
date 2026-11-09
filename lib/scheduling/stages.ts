// Appointment stages (#7, placeholder) — a visit broken into steps, each owned by a role
// and shown in a colour. The clinic defines the steps per appointment type from Settings
// (with Dr. Asif); Cara ships none. Pure constants and rules, safe on the client.
import { ROLES, ROLE_LABELS, isRole, type Role } from "@/lib/rbac";
import { FLAG_TONES } from "@/lib/scheduling/flags";

/// The same tag palette patient flags use.
export const STAGE_TONES = FLAG_TONES;

export const STAGE_ROLES: readonly Role[] = ROLES;

export function stageRoleLabel(role: string): string {
  return isRole(role) ? ROLE_LABELS[role] : role;
}

/// Stages are ticked on the day of the visit — not before check-in, not on a visit that
/// didn't happen.
export const STAGE_TICK_STATUSES = ["checked_in", "in_progress", "completed"] as const;

/// Who may tick a stage: someone holding the stage's role, or a CRM admin.
export function mayTickStage(userRole: string | null | undefined, stageRole: string): boolean {
  return userRole === "crm_admin" || (!!userRole && userRole === stageRole);
}
