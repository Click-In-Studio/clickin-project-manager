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
import { hasPermission, type PermissionContext } from "./permissions";

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
  userId: string,
  eventId: string,
): Promise<EventPermContext> {
  const pool = getPool();
  const [callRes, followerRes, participantRes, pocRes, memberRes] = await Promise.all([
    pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM event_call_time WHERE event_id = $1 AND user_id = $2) AS exists`,
      [eventId, userId]
    ),
    pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM event_participant WHERE event_id = $1 AND user_id = $2) AS exists`,
      [eventId, userId]
    ),
    pool.query<{ department_id: string }>(
      `SELECT department_id FROM event_participant
       WHERE event_id = $1 AND user_id = $2 AND department_id IS NOT NULL`,
      [eventId, userId]
    ),
    // POC membership is production-wide
    pool.query<{ department_id: string }>(
      `SELECT edm.department_id
       FROM event_department_member edm
       JOIN event_department ed ON ed.id = edm.department_id
       JOIN production_event pe ON pe.production_id = ed.production_id
       WHERE pe.id = $1 AND edm.user_id = $2 AND edm.is_poc = true`,
      [eventId, userId]
    ),
    // All production-wide dept membership for this event's production
    pool.query<{ department_id: string }>(
      `SELECT edm.department_id
       FROM event_department_member edm
       JOIN event_department ed ON ed.id = edm.department_id
       JOIN production_event pe ON pe.production_id = ed.production_id
       WHERE pe.id = $1 AND edm.user_id = $2`,
      [eventId, userId]
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

/** Can write / publish a report. */
export function canWriteReport(
  permCtx: PermissionContext,
  ctx: Pick<EventPermContext, "isInCall">,
): boolean {
  if (permCtx.isAdmin) return true;
  if (permCtx.memberPermissions === null) return false;
  if (hasPermission("report:publish", permCtx)) return true;
  if (hasPermission("event:publish", permCtx)) return ctx.isInCall;
  return false;
}

/** Can add or edit a tech requirement. */
export function canEditTechReq(
  permCtx: PermissionContext,
  ctx: Pick<EventPermContext, "pocDeptIds">,
  techReqDeptId: string | null,
): boolean {
  if (permCtx.isAdmin) return true;
  if (hasPermission("event:create", permCtx) || hasPermission("event:edit_schedule", permCtx)) return true;
  if (techReqDeptId && ctx.pocDeptIds.includes(techReqDeptId)) return true;
  return false;
}

/** Can assign tech personnel to a requirement. Same logic as canEditTechReq. */
export function canAssignTechReq(
  permCtx: PermissionContext,
  ctx: Pick<EventPermContext, "pocDeptIds">,
  techReqDeptId: string | null,
): boolean {
  return canEditTechReq(permCtx, ctx, techReqDeptId);
}

/** Can view a tech requirement. */
export function canViewTechReq(
  permCtx: PermissionContext,
  ctx: Pick<EventPermContext, "participantDeptIds">,
  techReqDeptId: string | null,
): boolean {
  if (permCtx.isAdmin) return true;
  if (hasPermission("event:view_tech_req_any", permCtx)) return true;
  if (techReqDeptId && ctx.participantDeptIds.includes(techReqDeptId)) return true;
  return false;
}

/** Can add/edit a department note on a report. */
export function canWriteNote(
  permCtx: PermissionContext,
  ctx: Pick<EventPermContext, "isInCall">,
): boolean {
  if (permCtx.memberPermissions === null) return false;
  if (permCtx.isAdmin) return true;
  if (hasPermission("report:create_note_any", permCtx)) return true;
  return ctx.isInCall;
}

/** Can delete or edit any note (not just own). */
export function canModerateNotes(permCtx: PermissionContext): boolean {
  if (permCtx.isAdmin) return true;
  return hasPermission("report:edit_note_any", permCtx);
}

/** Returns true if the user can view unpublished reports. */
export function isReportViewer(permCtx: PermissionContext): boolean {
  return permCtx.isAdmin || hasPermission("event:edit", permCtx) || hasPermission("event:edit_schedule", permCtx);
}

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
