/**
 * Contextual (Type B) permission checks for the event system.
 *
 * Phase 5: edit/write operations now gate on per-instance resource_grant rows.
 * Contextual state (isInCall, isFollower) is retained for note writing and
 * read-level checks that remain role-based.
 *
 * Type A (role-only) event permissions for admin bypass still use hasPermission().
 */

import { getPool } from "./pg";
import { hasPermission, type PermissionContext } from "./permissions";
import { hasResourceGrantLevel } from "./resource-grant-db";

// ─── Context loader ───────────────────────────────────────────────────────────

export type EventPermContext = {
  /** True if the user has an event_call_time record for this event. */
  isInCall: boolean;
  /** True if the user has an event_participant row (is following this event). */
  isFollower: boolean;
  /** dept IDs (event_department.id) the user is assigned to as a participant. */
  participantDeptIds: string[];
  /** event_department.id values where user is POC (used for tech_req dept filter in UI). */
  pocDeptIds: string[];
  /** All event_department.id values the user belongs to production-wide (for note reply check). */
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
    pool.query<{ department_id: string }>(
      `SELECT edm.department_id
       FROM event_department_member edm
       JOIN event_department ed ON ed.id = edm.department_id
       JOIN production_event pe ON pe.production_id = ed.production_id
       WHERE pe.id = $1 AND edm.user_id = $2 AND edm.is_poc = true`,
      [eventId, userId]
    ),
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

/**
 * Can write / edit a specific report.
 * Primary: resource_grant(report, reportId, 'edit'+).
 * Fallback: isInCall still allows note writing (for tech dept staff in call).
 */
export async function canWriteReport(
  permCtx: PermissionContext,
  reportId: string,
  productionId: string,
): Promise<boolean> {
  if (permCtx.isAdmin) return true;
  if (permCtx.memberPermissions === null) return false;
  return hasResourceGrantLevel(permCtx.userId, productionId, "report", reportId, "edit");
}

/**
 * Can publish a specific report.
 */
export async function canPublishReport(
  permCtx: PermissionContext,
  reportId: string,
  productionId: string,
): Promise<boolean> {
  if (permCtx.isAdmin) return true;
  if (permCtx.memberPermissions === null) return false;
  return hasResourceGrantLevel(permCtx.userId, productionId, "report", reportId, "publish");
}

/**
 * Can add or edit a specific tech requirement.
 * Primary: resource_grant(tech_req, reqId, 'edit'+).
 * Event-level edit also grants access (cascades down to all tech_reqs in the event).
 */
export async function canEditTechReq(
  permCtx: PermissionContext,
  techReqId: string,
  eventId: string,
  productionId: string,
): Promise<boolean> {
  if (permCtx.isAdmin) return true;
  if (permCtx.memberPermissions === null) return false;
  const [hasReqGrant, hasEventGrant] = await Promise.all([
    hasResourceGrantLevel(permCtx.userId, productionId, "tech_req", techReqId, "edit"),
    hasResourceGrantLevel(permCtx.userId, productionId, "event", eventId, "edit"),
  ]);
  return hasReqGrant || hasEventGrant;
}

/** Can assign tech personnel to a requirement. Same rule as canEditTechReq. */
export async function canAssignTechReq(
  permCtx: PermissionContext,
  techReqId: string,
  eventId: string,
  productionId: string,
): Promise<boolean> {
  return canEditTechReq(permCtx, techReqId, eventId, productionId);
}

/** Can view a tech requirement (for display gating in the list). */
export async function canViewTechReq(
  permCtx: PermissionContext,
  techReqId: string,
  eventId: string,
  productionId: string,
  techReqDeptId: string | null,
  ctx: Pick<EventPermContext, "participantDeptIds">,
): Promise<boolean> {
  if (permCtx.isAdmin) return true;
  if (hasPermission("event:view_tech_req_any", permCtx)) return true;
  // Participants of the req's dept can view
  if (techReqDeptId && ctx.participantDeptIds.includes(techReqDeptId)) return true;
  // Or if user has any grant on this req
  const level = await hasResourceGrantLevel(permCtx.userId, productionId, "tech_req", techReqId, "view");
  return level;
}

/**
 * Can add/edit a department note on a report.
 * Primary: resource_grant(report, reportId, 'edit'+) OR isInCall.
 */
export async function canWriteNote(
  permCtx: PermissionContext,
  reportId: string,
  productionId: string,
  isInCall: boolean,
): Promise<boolean> {
  if (permCtx.memberPermissions === null) return false;
  if (permCtx.isAdmin) return true;
  if (isInCall) return true;
  return hasResourceGrantLevel(permCtx.userId, productionId, "report", reportId, "edit");
}

/** Synchronous fallback for contexts where reportId is not available. Matches isInCall only. */
export function canWriteNoteInCall(
  permCtx: PermissionContext,
  isInCall: boolean,
): boolean {
  if (permCtx.memberPermissions === null) return false;
  if (permCtx.isAdmin) return true;
  return isInCall;
}

/** Can delete or edit any note (not just own). */
export function canModerateNotes(permCtx: PermissionContext): boolean {
  if (permCtx.isAdmin) return true;
  return hasPermission("report:edit_note_any", permCtx);
}

/**
 * Returns true if the user can view unpublished reports.
 * Phase 5a: event:edit/edit_schedule are now resource_grant levels; use event:create as a
 * synchronous proxy for "SM/producer" role until Phase 5b migrates reports to resource_grant.
 */
export function isReportViewer(permCtx: PermissionContext): boolean {
  if (permCtx.isAdmin) return true;
  return hasPermission("event:create", permCtx);
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
