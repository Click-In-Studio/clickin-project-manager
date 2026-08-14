/**
 * Contextual (Type B) permission checks for the event system.
 *
 * Phase 5: edit/write operations now gate on per-instance production_member_grant rows.
 * Contextual state (isInCall, isFollower) is retained for note writing and
 * read-level checks that remain role-based.
 *
 * Type A (role-only) event permissions for admin bypass still use hasPermission().
 */

import { getPool } from "./pg";
import { type PermissionContext } from "./permissions";
import { hasGrant } from "./grant-check";

// ─── Context loader ───────────────────────────────────────────────────────────

export type EventPermContext = {
  /** True if the user has an event_call_time record for this event. */
  isInCall: boolean;
  /** True if the user has an event_participant row (is following this event). */
  isFollower: boolean;
  /** dept IDs (production_dept.id) the user is assigned to as a participant. */
  participantDeptIds: string[];
  /** production_dept.id values where user is POC (used for tech_req dept filter in UI). */
  pocDeptIds: string[];
  /** All production_dept.id values the user belongs to production-wide (for note reply check). */
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
      `SELECT edm.dept_id AS department_id
       FROM production_dept_member edm
       JOIN production_event pe ON pe.production_id = edm.production_id
       WHERE pe.id = $1 AND edm.user_id = $2 AND edm.is_poc = true`,
      [eventId, userId]
    ),
    pool.query<{ department_id: string }>(
      `SELECT edm.dept_id AS department_id
       FROM production_dept_member edm
       JOIN production_event pe ON pe.production_id = edm.production_id
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

// ─── 域级门 helper（消除路由层复制，review findings 1/2）───────────────────────

import { hasAnyEffectiveGrant, hasEffectiveGrant, type GrantActor } from "./grant-check";

/** event 域读取门的节点集（原 event:follow 读取职责）。改这里=改所有调用点。 */
export const EVENT_DOMAIN_VIEW_SUBS = ["meta", "details"] as const;

/** event 域可见（任一 meta/details view 行；admin/owner 旁路）。 */
export function hasEventDomainView(actor: GrantActor, productionId: string): Promise<boolean> {
  return hasAnyEffectiveGrant(actor, productionId, "event", EVENT_DOMAIN_VIEW_SUBS, "view");
}

/** 事件内容写门（状态感知）：published → publication@edit；否则 details@edit。 */
export function hasEventContentEdit(
  actor: GrantActor, productionId: string, eventId: string, status: string,
): Promise<boolean> {
  const sub = status === "published" ? "publication" : "details";
  return hasEffectiveGrant(actor, productionId, "event", eventId, sub, "edit");
}

// ─── Permission checks ────────────────────────────────────────────────────────

/**
 * Can write / edit a specific report.
 * Primary: production_member_grant(report, reportId, 'edit'+).
 * Fallback: isInCall still allows note writing (for tech dept staff in call).
 */
export async function canWriteReport(
  permCtx: PermissionContext,
  reportId: string,
  productionId: string,
): Promise<boolean> {
  if (permCtx.isAdmin) return true;
  if (permCtx.memberPermissions === null) return false;
  return hasGrant(permCtx.userId, productionId, "report", reportId, "*", "edit");
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
  return hasGrant(permCtx.userId, productionId, "report", reportId, "publication", "create");
}

/**
 * Can add or edit a specific tech requirement.
 * Primary: production_member_grant(tech_req, reqId, 'edit'+).
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
    hasGrant(permCtx.userId, productionId, "task", techReqId, "*", "edit"),
    hasGrant(permCtx.userId, productionId, "event", eventId, "details", "edit"),
  ]);
  if (hasReqGrant || hasEventGrant) return true;
  // 规则（用户规范）：不论创建路径与进度，task 关联部门的 POC 恒可编辑内容并推进
  // 状态——上下文关系判定（Type B），部门后关联/POC 变更自动跟踪，无需行同步
  const { getEventTechReq, isUserDeptPoc } = await import("./event-db");
  const req = await getEventTechReq(techReqId, eventId);
  if (req?.departmentId && await isUserDeptPoc(req.departmentId, permCtx.userId)) return true;
  return false;
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
  if (await hasGrant(permCtx.userId, productionId, "task", "*", "*", "view")) return true;
  if (await hasGrant(permCtx.userId, productionId, "event", eventId, "tasks", "view")) return true;
  // Participants of the req's dept can view
  if (techReqDeptId && ctx.participantDeptIds.includes(techReqDeptId)) return true;
  // Or if user has any grant on this req
  if (await hasGrant(permCtx.userId, productionId, "task", techReqId, "*", "view")) return true;
  // 规则（用户规范，上下文判定）：
  //   - assign 了个人 → 个人恒可见（并可推进进度，见 status 路由）
  //   - task 已确认（非 awaiting）且关联部门 → 部门全员可见
  const { isUserReqAssignee, isUserDeptMember, getEventTechReq } = await import("./event-db");
  if (await isUserReqAssignee(techReqId, permCtx.userId)) return true;
  if (techReqDeptId) {
    const req = await getEventTechReq(techReqId, eventId);
    if (req && req.status !== "awaiting" && await isUserDeptMember(techReqDeptId, permCtx.userId)) return true;
  }
  return false;
}

/** note 创建通道（落库到 event_report_note.created_via）：
 *  dept=本部门（参与者上下文/POC 实例行）/ wildcard=通配权（导演类）/
 *  moderator=event 编辑者（organizer 蹭 details@edit 的蕴含，用户确认保留）。 */
export type NoteWriteChannel = "dept" | "wildcard" | "moderator";

/**
 * Can create a note for a specific department in a report.
 * 返回命中的通道，null=不可创建。批C C3：dept/<D>/notes@create 行
 * （POC 上任自动发；导演 dept/* 通配模板）为一等授权面；
 * 部门参与者上下文保留（成员通道，剧组设置暂不收）。
 */
export async function canWriteNote(
  permCtx: PermissionContext,
  productionId: string,
  eventId: string,
  departmentId: string,
  participantDeptIds: string[],
): Promise<NoteWriteChannel | null> {
  if (permCtx.memberPermissions === null) return null;
  if (permCtx.isAdmin) return "moderator";
  if (participantDeptIds.includes(departmentId)) return "dept";
  if (await hasGrant(permCtx.userId, productionId, "dept", departmentId, "notes", "create")) {
    // 归因：POC = 本部门通道；其余（通配/被授实例行的非 POC）= wildcard。
    // 边界情形标 wildcard 只是更保守（POC 删不了那条 note），不放大权限。
    const pocRes = await getPool().query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM production_dept_member
         WHERE dept_id = $1 AND user_id = $2 AND is_poc = true
       ) AS exists`,
      [departmentId, permCtx.userId],
    );
    return pocRes.rows[0].exists ? "dept" : "wildcard";
  }
  if (await hasGrant(permCtx.userId, productionId, "event", eventId, "details", "edit")) return "moderator";
  return null;
}

/**
 * Can edit or delete an existing note.
 * SM（event edit+ grant）或"是该 note 所属 dept 的参与者且是作者"。
 */
export async function canEditNote(
  permCtx: PermissionContext,
  productionId: string,
  eventId: string,
  note: { authorUserId: string; departmentId: string; createdVia: string },
  participantDeptIds: string[],
  verb: "edit" | "delete",
): Promise<boolean> {
  if (permCtx.isAdmin) return true;
  if (await hasGrant(permCtx.userId, productionId, "event", eventId, "details", "edit")) return true;
  if (permCtx.userId === note.authorUserId && participantDeptIds.includes(note.departmentId)) return true;
  // 批C C3：POC（dept/<D>/notes@edit|delete 行）可管**本部门通道**提出的 note；
  // 导演（wildcard）/moderator 通道提出的不在此列（created_via 过滤，树无作者维度）
  return note.createdVia === "dept"
    && await hasGrant(permCtx.userId, productionId, "dept", note.departmentId, "notes", verb);
}

/**
 * Can moderate any note or reply (delete others' content).
 * SM（event edit+ grant）。
 */
export async function canModerateNotes(
  permCtx: PermissionContext,
  productionId: string,
  eventId: string,
): Promise<boolean> {
  if (permCtx.isAdmin) return true;
  return hasGrant(permCtx.userId, productionId, "event", eventId, "details", "edit");
}

/**
 * Returns true if the user can view unpublished reports.
 * Phase 5a: event:edit/edit_schedule are now production_member_grant levels; use event:create as a
 * synchronous proxy for "SM/producer" role until Phase 5b migrates reports to production_member_grant.
 */
export async function isReportViewer(permCtx: PermissionContext, productionId: string): Promise<boolean> {
  if (permCtx.isAdmin) return true;
  // 批B：查看未发布报告是独立可授节点（event/<id>/reports@view）；
  // organizer 经迁移/模板保真获得通配行，但该能力从此与创建权解耦
  return hasGrant(permCtx.userId, productionId, "event", "*", "reports", "view");
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

// ─── Draft 事件可见性（事件列表 / 计划面板共用——防止两页规则分叉）────────────

import { listGrantedResourceIds } from "./grant-check";

const DRAFT_VISIBLE_STATUSES = new Set(["published", "completed"]);

/**
 * 过滤 draft 事件可见性：published/completed 全员可见；
 * draft 需 publication@view 行（admin/owner 旁路、通配全见、或实例 ids 命中）。
 */
export async function filterDraftVisibleEvents<T extends { id: string; status: string }>(
  permCtx: { userId: string; isAdmin: boolean; isOwner: boolean },
  productionId: string,
  events: T[],
): Promise<T[]> {
  if (permCtx.isAdmin || permCtx.isOwner) return events;
  const vis = await listGrantedResourceIds(permCtx.userId, productionId, "event", "publication", "view");
  if (vis.wildcard) return events;
  return events.filter(e => DRAFT_VISIBLE_STATUSES.has(e.status) || vis.ids.includes(e.id));
}
