/**
 * Contextual (Type B) permission checks for the event system.
 *
 * These cannot be resolved purely from role membership — they require runtime
 * state like "is this SM in the event call?" or "is this user a POC for the
 * tech req's department?".
 *
 * Type A (role-only) event permissions live in roles.ts as `event:*` entries
 * and are evaluated with the regular `hasPermission()` function.
 */

import { getPool } from "./pg";
import { hasPermission } from "./roles";
import type { PermissionOverrides } from "./roles";

// ─── Context loader ───────────────────────────────────────────────────────────

/**
 * Loads all event-scoped context needed for permission decisions.
 * Call once per request, then pass the result to the individual check functions.
 */
export type EventPermContext = {
  /** True if the user has an event_call_time record for this event. */
  isInCall: boolean;
  /** True if the user has an event_participant row (is following this event). */
  isFollower: boolean;
  /** dept IDs the user is assigned to as a participant in this event. */
  participantDeptIds: string[];
  /** dept IDs for which the user is a POC. */
  pocDeptIds: string[];
  /** All dept IDs the user belongs to in this production (production-wide). */
  memberDeptIds: string[];
};

export async function loadEventPermContext(
  openId: string,
  eventId: string,
): Promise<EventPermContext> {
  const pool = getPool();
  const [callRes, followerRes, participantRes, pocRes, memberRes] = await Promise.all([
    pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM event_call_time WHERE event_id = $1 AND open_id = $2) AS exists`,
      [eventId, openId]
    ),
    pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM event_participant WHERE event_id = $1 AND open_id = $2) AS exists`,
      [eventId, openId]
    ),
    pool.query<{ department_id: string }>(
      `SELECT department_id FROM event_participant
       WHERE event_id = $1 AND open_id = $2 AND department_id IS NOT NULL`,
      [eventId, openId]
    ),
    // POC membership is production-wide
    pool.query<{ department_id: string }>(
      `SELECT edm.department_id
       FROM event_department_member edm
       JOIN event_department ed ON ed.id = edm.department_id
       JOIN production_event pe ON pe.production_id = ed.production_id
       WHERE pe.id = $1 AND edm.open_id = $2 AND edm.is_poc = true`,
      [eventId, openId]
    ),
    // All production-wide dept membership for this event's production
    pool.query<{ department_id: string }>(
      `SELECT edm.department_id
       FROM event_department_member edm
       JOIN event_department ed ON ed.id = edm.department_id
       JOIN production_event pe ON pe.production_id = ed.production_id
       WHERE pe.id = $1 AND edm.open_id = $2`,
      [eventId, openId]
    ),
  ]);
  return {
    isInCall:           callRes.rows[0].exists,
    isFollower:         followerRes.rows[0].exists,
    participantDeptIds: participantRes.rows.map(r => r.department_id),
    pocDeptIds:         pocRes.rows.map(r => r.department_id),
    memberDeptIds:      memberRes.rows.map(r => r.department_id),
  };
}

// ─── Permission checks ────────────────────────────────────────────────────────

/**
 * Can write / publish a report.
 * 制作人 / 制作助理: unconditional.
 * 舞台监督 / 助理舞台监督: only if in the event call.
 */
export function canWriteReport(
  isAdmin: boolean,
  memberRoles: string[] | null,
  overrides: PermissionOverrides,
  ctx: Pick<EventPermContext, "isInCall">,
): boolean {
  if (isAdmin) return true;
  if (!memberRoles) return false;
  if (hasPermission("event:publish", isAdmin, memberRoles, overrides)) {
    // 制作人 / 制作助理 pass unconditionally
    if (memberRoles.some(r => r === "制作人" || r === "制作助理")) return true;
    // SM roles only if in call
    const isSm = memberRoles.some(r => r === "舞台监督" || r === "助理舞台监督");
    return isSm && ctx.isInCall;
  }
  return false;
}

/**
 * Can add or edit a tech requirement.
 * Passes if role-based check succeeds, OR if the user is a POC of the
 * requirement's department.
 */
export function canEditTechReq(
  isAdmin: boolean,
  memberRoles: string[] | null,
  overrides: PermissionOverrides,
  ctx: Pick<EventPermContext, "pocDeptIds">,
  techReqDeptId: string | null,
): boolean {
  // SM + director roles + 技术导演 pass unconditionally
  const baseRoles = new Set([
    "制作人", "制作助理", "舞台监督", "助理舞台监督",
    "导演", "导演助理", "技术导演",
  ]);
  if (isAdmin) return true;
  if (memberRoles?.some(r => baseRoles.has(r))) return true;
  // Dept POC: can only edit reqs belonging to their own department
  if (techReqDeptId && ctx.pocDeptIds.includes(techReqDeptId)) return true;
  return false;
}

/**
 * Can assign tech personnel to a requirement.
 * Same set as canEditTechReq (same roles + own-dept POC).
 */
export function canAssignTechReq(
  isAdmin: boolean,
  memberRoles: string[] | null,
  overrides: PermissionOverrides,
  ctx: Pick<EventPermContext, "pocDeptIds">,
  techReqDeptId: string | null,
): boolean {
  return canEditTechReq(isAdmin, memberRoles, overrides, ctx, techReqDeptId);
}

/**
 * Can view a tech requirement.
 * Full-access roles pass unconditionally; others pass if they are a
 * participant assigned to the requirement's department in this event.
 */
export function canViewTechReq(
  isAdmin: boolean,
  memberRoles: string[] | null,
  overrides: PermissionOverrides,
  ctx: Pick<EventPermContext, "participantDeptIds">,
  techReqDeptId: string | null,
): boolean {
  const fullAccessRoles = new Set([
    "制作人", "制作助理", "舞台监督", "助理舞台监督",
    "导演", "导演助理", "技术导演",
  ]);
  if (isAdmin) return true;
  if (memberRoles?.some(r => fullAccessRoles.has(r))) return true;
  if (techReqDeptId && ctx.participantDeptIds.includes(techReqDeptId)) return true;
  return false;
}

const NOTE_WRITE_ROLES = new Set([
  "制作人", "制作助理", "舞台监督", "助理舞台监督", "导演", "导演助理",
]);

const NOTE_MODERATE_ROLES = new Set([
  "制作人", "制作助理", "舞台监督", "助理舞台监督",
]);

/** Can add/edit a department note on a report. */
export function canWriteNote(
  isAdmin: boolean,
  memberRoles: string[] | null,
  ctx: Pick<EventPermContext, "isInCall">,
): boolean {
  if (!memberRoles) return false;
  if (isAdmin) return true;
  if (memberRoles.some(r => NOTE_WRITE_ROLES.has(r))) return true;
  return ctx.isInCall;
}

/** Can delete or edit any note (not just own). */
export function canModerateNotes(
  isAdmin: boolean,
  memberRoles: string[] | null,
): boolean {
  if (isAdmin) return true;
  return memberRoles?.some(r => NOTE_MODERATE_ROLES.has(r)) ?? false;
}

/** Roles that can view unpublished reports without event:view_full. */
export const REPORT_VIEWER_ROLES = new Set([
  "制作人", "制作助理", "舞台监督", "助理舞台监督", "导演", "导演助理",
]);

/**
 * Can reply to the report body or to any existing reply.
 * Followers and called users (isInCall) both qualify.
 */
export function canReplyToReport(isAdmin: boolean, isFollower: boolean, isInCall: boolean): boolean {
  return isAdmin || isFollower || isInCall;
}

/** Same rule applies to replies-of-replies (no depth limit). */
export const canReplyToReply = canReplyToReport;

/**
 * Can reply to a specific department note.
 * Must be a follower/in-call AND be a member of that department (production-wide).
 */
export function canReplyToReportNote(
  isAdmin: boolean,
  isFollower: boolean,
  isInCall: boolean,
  memberDeptIds: string[],
  noteDeptId: string,
): boolean {
  return isAdmin || ((isFollower || isInCall) && memberDeptIds.includes(noteDeptId));
}

/**
 * Can view call times and receive call notifications.
 * Requires being a follower.
 */
export function canViewCall(isFollower: boolean): boolean {
  return isFollower;
}

/**
 * Can view and receive reports.
 * Requires being a follower.
 */
export function canViewReport(isFollower: boolean): boolean {
  return isFollower;
}
