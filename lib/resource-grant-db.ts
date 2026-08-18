/**
 * Resource Grant DB — 资源实例级访问权限查询与自我确认。
 *
 * 支持 cue_list / event / report / tech_req / note 等资源类型。
 *
 * 免审批区间（自我确认条件，checkNodeFreeApprovalZone / checkCueListFreeApprovalZone）：
 *   - edit 级：user 所在 dept 持有该实例的节点区间键（production_dept_permission，
 *              含 `node:<type>/*@edit` 通配），或 user 是管理该资源（rdm）的 dept 的 POC
 *   - manage 级：user 是管理该资源的 dept 的 POC（代码规则，总表 §0.8 已知例外）
 */
import { getPool } from "./pg";
import { policyFilteredRows } from "./policy-db";
import type { Pool, PoolClient } from "pg";

/** 可注入连接：调用方在事务内传 client，缺省用池（W5 AI review——多步写点须同事务） */
type Queryable = Pool | PoolClient;

// ─── Generic resource grant helpers ──────────────────────────────────────────
//
// 已退役（2026-08-17，随 checkResourceFreeApprovalZone 一并清理）：
//   getResourceGrantLevel / hasResourceGrantLevel —— 按 resource_permission_level.sort_order
//     做等级比较，与非线性不变量（总表 §0.1「权限=原子行的集合，无任何蕴含」）正面冲突，
//     且全库零消费点。判定一律走 hasGrant（行精确命中）。
//   checkResourceFreeApprovalZone —— dept 区间查 dept.permissions[] 数组 + 伪键
//     （'report:edit' 等）。伪键随批C 清零、数组列随 PR #229 并表批 DROP，函数却留着，
//     报告自确认路由的 edit 档因此必 500。通用替代：checkNodeFreeApprovalZone（下方，
//     查 production_dept_permission 节点键）。

/**
 * Writes a self_confirmed production_member_grant for any resource type.
 * Idempotent: ON CONFLICT DO NOTHING.
 */
export async function selfConfirmResourceGrant(
  userId: string,
  productionId: string,
  resourceType: string,
  resourceId: string,
  level: string,
): Promise<void> {
  // 批B：REST 化域（event/task）伪级别展开为动词行集；未迁移域（report/note）仍写单行
  const sets: Record<string, Record<string, ReadonlyArray<readonly [string, string]>>> = {
    event: EVENT_LEVEL_ROW_SETS,
    task: TASK_LEVEL_ROW_SETS,
    report: REPORT_LEVEL_ROW_SETS,
    note: NOTE_LEVEL_ROW_SETS,
    wiki: WIKI_LEVEL_ROW_SETS,
  };
  const rows = sets[resourceType]?.[level] ?? [["*", level] as const];
  for (const [sub, verb] of rows) {
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'self_confirmed', $2)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [productionId, userId, resourceType, resourceId, sub, verb],
    );
  }
}

// ─── Typed level helpers ──────────────────────────────────────────────────────

export type EventLevel = "view" | "edit" | "publish" | "edit_published" | "revoke" | "manage";
export type ReportLevel = "view" | "edit" | "publish" | "edit_published" | "revoke" | "manage";
export type TechReqLevel = "view" | "edit" | "assign" | "manage";
export type NoteLevel = "view" | "edit" | "manage";

/**
 * 批B：event / task 伪级别 → 动词行集（授权面统一展开表，同 CUE_LIST_LEVEL_ROW_SETS）。
 * 非线性：publish 系与 edit 无蕴含（各自独立申请）；manage=全集+grants。
 * assignees 是保留段（assign 独立能力，'*' 通配不覆盖）。
 */
export const EVENT_LEVEL_ROW_SETS: Record<EventLevel, ReadonlyArray<readonly [string, string]>> = {
  view:           [["meta", "view"], ["details", "view"]],
  edit:           [["meta", "view"], ["details", "view"], ["publication", "view"], ["*", "edit"],
                   ["tasks", "create"], ["tasks", "delete"],
                   ["reports", "create"], ["reports", "delete"]],
  publish:        [["publication", "create"]],
  edit_published: [["publication", "edit"]],
  revoke:         [["publication", "delete"]],
  // 2026-08-13 用户定稿（两个指派面）：organizer 默认含 assignees@c/d（名单）+
  // call_sheet@edit（排 call），**不含 publication@create**——发布动作归舞监 role
  // （模板 event/*/publication@c/d）；organizer 保留 publication@edit/delete（修订/撤回）
  manage:         [["meta", "view"], ["details", "view"], ["publication", "view"], ["*", "edit"],
                   ["assignees", "create"], ["assignees", "delete"], ["call_sheet", "edit"],
                   ["tasks", "create"], ["tasks", "delete"],
                   ["reports", "create"], ["reports", "delete"],
                   ["publication", "edit"], ["publication", "delete"],
                   ["grants", "edit"]],
};

export const REPORT_LEVEL_ROW_SETS: Record<ReportLevel, ReadonlyArray<readonly [string, string]>> = {
  view:           [["meta", "view"]],
  edit:           [["meta", "view"], ["publication", "view"], ["*", "edit"],
                   ["notes", "create"], ["notes", "delete"]],
  publish:        [["publication", "create"]],
  edit_published: [["publication", "edit"]],
  revoke:         [["publication", "delete"]],
  manage:         [["meta", "view"], ["publication", "view"], ["*", "edit"],
                   ["notes", "create"], ["notes", "delete"],
                   ["publication", "create"], ["publication", "edit"], ["publication", "delete"],
                   ["grants", "edit"]],
};

export const NOTE_LEVEL_ROW_SETS: Record<NoteLevel, ReadonlyArray<readonly [string, string]>> = {
  view:   [["*", "view"]],
  edit:   [["*", "view"], ["*", "edit"]],
  manage: [["*", "view"], ["*", "edit"], ["*", "delete"], ["grants", "edit"]],
};

// wiki 文档库（W2）：meta@view=目录/标题可见（树中可见该节点），*@view=内容。
// 分享档 view/edit 供 grants@edit 持有者发行；manage=创建者行集（writeWikiGrants）。
export type WikiLevel = "view" | "edit" | "manage";
export const WIKI_LEVEL_ROW_SETS: Record<WikiLevel, ReadonlyArray<readonly [string, string]>> = {
  view:   [["meta", "view"], ["*", "view"]],
  edit:   [["meta", "view"], ["*", "view"], ["*", "edit"]],
  manage: [["meta", "view"], ["*", "view"], ["*", "edit"], ["*", "delete"], ["grants", "edit"]],
};

export type TaskLevel = "view" | "edit" | "assign" | "manage";
export const TASK_LEVEL_ROW_SETS: Record<TaskLevel, ReadonlyArray<readonly [string, string]>> = {
  view:   [["*", "view"]],
  edit:   [["*", "view"], ["*", "edit"]],
  assign: [["*", "view"], ["assignees", "edit"]],
  manage: [["*", "view"], ["*", "edit"], ["assignees", "edit"], ["*", "delete"], ["grants", "edit"]],
};

/** 通用节点 zone（六步链第 3 步，dept 面）：edit 档=dept_permission 节点键∪管理 dept POC；
 *  manage 档=管理 dept POC（代码规则）。cue 版语义的类型通用化。 */
export async function checkNodeFreeApprovalZone(
  userId: string,
  productionId: string,
  resourceType: string,
  resourceId: string,
  level: "edit" | "manage",
): Promise<boolean> {
  if (level === "manage") {
    const { rows } = await getPool().query(
      `SELECT 1
       FROM resource_dept_manage rdm
       JOIN production_dept_member pdm ON pdm.dept_id = rdm.dept_id
       WHERE rdm.production_id = $1
         AND rdm.resource_type = $2
         AND rdm.resource_id IN ($3, '*')
         AND pdm.user_id = $4
         AND pdm.is_poc = true
       LIMIT 1`,
      [productionId, resourceType, resourceId, userId],
    );
    return rows.length > 0;
  }
  const editKeys = [
    `node:${resourceType}/${resourceId}@edit`,
    `node:${resourceType}/*@edit`,
  ];
  const { rows } = await getPool().query(
    `SELECT 1
     FROM production_dept_member pdm
     WHERE pdm.production_id = $1
       AND pdm.user_id = $2
       AND (
         EXISTS (
           SELECT 1 FROM production_dept_permission pdp
           WHERE pdp.dept_id = pdm.dept_id AND pdp.permission_key = ANY($5)
         )
         OR (pdm.is_poc AND EXISTS (
           SELECT 1 FROM resource_dept_manage rdm
           WHERE rdm.production_id = $1
             AND rdm.resource_type = $3
             AND rdm.resource_id IN ($4, '*')
             AND rdm.dept_id = pdm.dept_id
         ))
       )
     LIMIT 1`,
    [productionId, userId, resourceType, resourceId, editKeys],
  );
  return rows.length > 0;
}

/** 从动词行推导 UI 伪级别（manage=grants edit > edit > view）。检查本体是动词行。 */
async function deriveNodePseudoLevel(
  userId: string,
  productionId: string,
  resourceType: string,
  resourceId: string,
  viewSubs: string[],
  editSubs: string[],
): Promise<"manage" | "edit" | "view" | null> {
  const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
    `SELECT resource_sub, permission_level FROM production_member_grant
     WHERE production_id = $1 AND user_id = $2
       AND resource_type = $3 AND resource_id IN ($4, '*')
       AND NOT is_revoked
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [productionId, userId, resourceType, resourceId],
  );
  const has = (subs: string[], verb: string) =>
    rows.some((r) => subs.includes(r.resource_sub) && r.permission_level === verb);
  if (has(["grants"], "edit")) return "manage";
  if (has(editSubs, "edit")) return "edit";
  if (has(viewSubs, "view")) return "view";
  return null;
}

export type ResourceAccessResult<L extends string> =
  | { canAccess: true; level: L }
  | { canAccess: false; canSelfConfirm: true; selfConfirmLevel: "manage" | "edit" }
  | { canAccess: false; canSelfConfirm: false };

/**
 * Full access check for an event resource:
 *   1. Active grant found → { canAccess: true, level }
 *   2. In manage free-approval zone → { canAccess: false, canSelfConfirm: true, selfConfirmLevel: 'manage' }
 *   3. In edit free-approval zone → { canAccess: false, canSelfConfirm: true, selfConfirmLevel: 'edit' }
 *   4. No zone → { canAccess: false, canSelfConfirm: false }
 */
export async function getEventAccess(
  userId: string,
  productionId: string,
  eventId: string,
): Promise<ResourceAccessResult<EventLevel>> {
  // 批B：动词行推导 + 节点 zone（伪级别仅供 UI 兼容）
  const level = await deriveNodePseudoLevel(
    userId, productionId, "event", eventId,
    ["meta", "details", "*"], ["details", "*"],
  );
  if (level) return { canAccess: true, level };
  const [canManage, canEdit] = await Promise.all([
    checkNodeFreeApprovalZone(userId, productionId, "event", eventId, "manage"),
    checkNodeFreeApprovalZone(userId, productionId, "event", eventId, "edit"),
  ]);
  if (canManage) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "manage" };
  if (canEdit) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "edit" };
  return { canAccess: false, canSelfConfirm: false };
}

export async function getReportAccess(
  userId: string,
  productionId: string,
  reportId: string,
): Promise<ResourceAccessResult<ReportLevel>> {
  // 批C：动词行推导 + 节点 zone（伪级别仅供 UI 兼容；report=挂载边类型）
  const level = await deriveNodePseudoLevel(
    userId, productionId, "report", reportId, ["meta", "*"], ["*"],
  );
  if (level) return { canAccess: true, level };
  const [canManage, canEdit] = await Promise.all([
    checkNodeFreeApprovalZone(userId, productionId, "report", reportId, "manage"),
    checkNodeFreeApprovalZone(userId, productionId, "report", reportId, "edit"),
  ]);
  if (canManage) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "manage" };
  if (canEdit) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "edit" };
  return { canAccess: false, canSelfConfirm: false };
}

export async function getTechReqAccess(
  userId: string,
  productionId: string,
  reqId: string,
): Promise<ResourceAccessResult<TechReqLevel>> {
  // 批B：tech_req 已更名 task（resource_type='task'）；动词行推导 + 节点 zone
  const level = await deriveNodePseudoLevel(
    userId, productionId, "task", reqId, ["*"], ["*"],
  );
  if (level) return { canAccess: true, level };
  const [canManage, canEdit] = await Promise.all([
    checkNodeFreeApprovalZone(userId, productionId, "task", reqId, "manage"),
    checkNodeFreeApprovalZone(userId, productionId, "task", reqId, "edit"),
  ]);
  if (canManage) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "manage" };
  if (canEdit) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "edit" };
  return { canAccess: false, canSelfConfirm: false };
}

/**
 * Returns true if the user has any active production_member_grant on any tech_req in the given event.
 * Used to gate access to the reqs page and the reqs link in the follower view.
 */
export async function hasUserAnyTechReqGrantInEvent(
  userId: string,
  productionId: string,
  eventId: string,
): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM production_member_grant rg
       JOIN task etr ON etr.id = rg.resource_id
       WHERE rg.production_id = $1
         AND rg.user_id = $2
         AND rg.resource_type = 'task'
         AND etr.event_id = $3
         AND NOT rg.is_revoked
         AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
     ) AS ok`,
    [productionId, userId, eventId],
  );
  return rows[0]?.ok ?? false;
}

/**
 * Returns the resource_ids of all tech_reqs in the given event where the user
 * has an active production_member_grant. Used to filter the reqs list for non-full viewers.
 */
export async function getUserTechReqGrantIdsInEvent(
  userId: string,
  productionId: string,
  eventId: string,
): Promise<string[]> {
  const { rows } = await getPool().query<{ resource_id: string }>(
    `SELECT DISTINCT rg.resource_id
     FROM production_member_grant rg
     JOIN task etr ON etr.id = rg.resource_id
     WHERE rg.production_id = $1
       AND rg.user_id = $2
       AND rg.resource_type = 'task'
       AND etr.event_id = $3
       AND NOT rg.is_revoked
       AND (rg.expires_at IS NULL OR rg.expires_at > NOW())`,
    [productionId, userId, eventId],
  );
  return rows.map(r => r.resource_id);
}

// ─── Grant-write helpers for new resource creation ────────────────────────────

/**
 * Writes initial production_member_grant + resource_dept_manage when a new event is created.
 *   - creator gets manage grant
 *   - depts holding the event collection-create zone key get resource_dept_manage
 *   - if no such depts exist, creator is written to resource_person_manage as fallback
 */
export async function writeEventGrants(
  eventId: string,
  productionId: string,
  createdBy: string,
): Promise<void> {
  const pool = getPool();
  // 批B：创建者获 EVENT manage 行集（动词行取代 manage 单行）。
  // #236：行集先过一遍 production 级策略开关——**裁在写点，不裁在 EVENT_LEVEL_ROW_SETS**，
  // 那张表同时是审批发行与「上级有没有这个权限」的定义（M-12），裁到表上会连带砍掉审批面。
  const eventRows = await policyFilteredRows(
    productionId, "event", "creator", EVENT_LEVEL_ROW_SETS.manage, pool,
  );
  for (const [sub, verb] of eventRows) {
    await pool.query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'event', $3, $4, $5, 'direct', $2)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [productionId, createdBy, eventId, sub, verb],
    );
  }
  // 事件管理 dept：持有集合 create 资格键的 dept 获归属 + 实例 zone 键
  // （原 dept 数组伪键「事件创建」的节点行版）
  await pool.query(
    `INSERT INTO resource_dept_manage
       (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
     SELECT $1, pdp.dept_id, 'event', $2, '*', $3
     FROM production_dept_permission pdp
     WHERE pdp.production_id = $1
       AND pdp.permission_key = 'node:event/*@create'
     ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING`,
    [productionId, eventId, createdBy],
  );
  await pool.query(
    `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
     SELECT $1, rdm.dept_id, k.key
     FROM resource_dept_manage rdm
     CROSS JOIN LATERAL (VALUES
       ('node:event/' || $2 || '@view'),
       ('node:event/' || $2 || '@edit')
     ) AS k(key)
     WHERE rdm.production_id = $1 AND rdm.resource_type = 'event' AND rdm.resource_id = $2
     ON CONFLICT (dept_id, permission_key) DO NOTHING`,
    [productionId, eventId],
  );
  // Person fallback: no dept managers → creator manages this event
  const hasDept = await pool.query(
    `SELECT 1 FROM resource_dept_manage
     WHERE production_id=$1 AND resource_type='event' AND resource_id=$2 LIMIT 1`,
    [productionId, eventId],
  );
  if (hasDept.rows.length === 0) {
    await pool.query(
      `INSERT INTO resource_person_manage
         (production_id, user_id, resource_type, resource_id, established_by)
       VALUES ($1,$2,'event',$3,$2)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub) DO NOTHING`,
      [productionId, createdBy, eventId],
    );
  }
}

/**
 * Writes initial production_member_grant + resource_dept_manage when a new report is created.
 * Inherits managing depts/persons from the parent event's resource_dept_manage /
 * resource_person_manage (not queried from dept permissions).
 */
export async function writeReportGrants(
  reportId: string,
  productionId: string,
  createdBy: string,
  eventId: string,
  db: Queryable = getPool(),
): Promise<void> {
  const pool = db;
  // 批C：创建者获 REPORT manage 行集。#236：先过策略开关（同 writeEventGrants 的理由）。
  const reportRows = await policyFilteredRows(
    productionId, "report", "creator", REPORT_LEVEL_ROW_SETS.manage, pool,
  );
  for (const [sub, verb] of reportRows) {
    await pool.query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'report', $3, $4, $5, 'direct', $2)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [productionId, createdBy, reportId, sub, verb],
    );
  }
  // Inherit dept managers from parent event
  await pool.query(
    `INSERT INTO resource_dept_manage
       (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
     SELECT production_id, dept_id, 'report', $1, '*', $2
     FROM resource_dept_manage
     WHERE production_id = $3 AND resource_type = 'event' AND resource_id = $4
     ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING`,
    [reportId, createdBy, productionId, eventId],
  );
  // Inherit person managers from parent event (person fallback)
  await pool.query(
    `INSERT INTO resource_person_manage
       (production_id, user_id, resource_type, resource_id, established_by)
     SELECT production_id, user_id, 'report', $1, $2
     FROM resource_person_manage
     WHERE production_id = $3 AND resource_type = 'event' AND resource_id = $4
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub) DO NOTHING`,
    [reportId, createdBy, productionId, eventId],
  );
}

/**
 * wiki 创建者行集（§0.9 定式 C-6）：creator 获 WIKI manage 行集 + person 归属。
 * 独立文档无父资源，不做 dept/person 继承（挂载为 report/note 时可见性沿边推导，
 * 永不物化行——§0.9 负面清单）。
 */
export async function writeWikiGrants(
  wikiId: string,
  productionId: string,
  createdBy: string,
  db: Queryable = getPool(),
): Promise<void> {
  const pool = db;
  // #236：先过策略开关。wiki 无外部归属信号，其 grants@edit 由 M-14 存在性子句强制
  // 保留、根本不在词汇表里，故本行集只有 *@delete 可配。
  const wikiRows = await policyFilteredRows(
    productionId, "wiki", "creator", WIKI_LEVEL_ROW_SETS.manage, pool,
  );
  for (const [sub, verb] of wikiRows) {
    await pool.query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'wiki', $3, $4, $5, 'self_confirmed', $2)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [productionId, createdBy, wikiId, sub, verb],
    );
  }
  await pool.query(
    `INSERT INTO resource_person_manage
       (production_id, user_id, resource_type, resource_id, resource_sub, established_by)
     VALUES ($1, $2, 'wiki', $3, '*', $2)
     ON CONFLICT DO NOTHING`,
    [productionId, createdBy, wikiId],
  );
}

/**
 * Writes initial production_member_grant + resource_dept_manage when a new task is created.
 *   - POC(s) of the assigned dept get manage grant
 *   - Assigned dept gets resource_dept_manage
 *   - If bound to an event: the event's managing depts/persons inherit
 *     resource_dept_manage / resource_person_manage（无绑定 task 无此继承）
 *   - If neither assigned dept nor event depts exist, creator is written to resource_person_manage
 * eventDeptId is a production_dept.id（并表后单一 id 空间，name 映射 hack 已退役）.
 */
export async function writeTechReqGrants(
  reqId: string,
  productionId: string,
  eventDeptId: string | null,
  createdBy: string,
  eventId: string | null,
): Promise<void> {
  const pool = getPool();
  if (eventDeptId) {
    // #236：POC 行集先过策略开关。`task.dept_poc:*@delete` **默认关**，于是本写点
    // 不再无条件发删除行——这正好把 V-1（「organizer 显式创建的 task，部门 POC 无
    // 自动删除权」）从空转救活：路由第三分支的 created_via 上下文规则此前被这里发出
    // 的行盖住，第一分支直接命中。
    //
    // 因此**不需要**在本写点按 created_via 分叉（原处方如此，已被更好的机制取代）：
    //   开关关（默认）⇒ 谁都不发 *@delete 行，dept_auto 路径的 POC 仍由路由的上下文
    //     分支恒可删 —— 与 V-1 完全等价
    //   开关开        ⇒ 关联部门 POC 一律拿到删除行 —— 即「任务归执行部门」那一档
    const pocRows = await policyFilteredRows(
      productionId, "task", "dept_poc",
      [["*", "view"], ["*", "edit"], ["assignees", "edit"], ["*", "delete"], ["grants", "edit"]],
      pool,
    );
    await pool.query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       SELECT DISTINCT $1, pdm.user_id, 'task', $2, s.sub, s.verb, 'direct', pdm.user_id
       FROM production_dept_member pdm
       CROSS JOIN UNNEST($4::text[], $5::text[]) AS s(sub, verb)
       WHERE pdm.dept_id = $3 AND pdm.is_poc = true
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [productionId, reqId, eventDeptId, pocRows.map((r) => r[0]), pocRows.map((r) => r[1])],
    );
    await pool.query(
      `INSERT INTO resource_dept_manage
         (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
       VALUES ($1, $3, 'task', $2, '*', $4::uuid)
       ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING`,
      [productionId, reqId, eventDeptId, createdBy],
    );
  }
  // Parent event's managing depts also manage the task (bound tasks only)
  // （曾误写 resource_type='tech_req' 死行——判定侧只读 'task'；存量由
  //   migrate-task-standalone 并入修复）
  if (eventId) {
    await pool.query(
      `INSERT INTO resource_dept_manage
         (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
       SELECT production_id, dept_id, 'task', $1, '*', $2
       FROM resource_dept_manage
       WHERE production_id = $3 AND resource_type = 'event' AND resource_id = $4
       ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING`,
      [reqId, createdBy, productionId, eventId],
    );
  }
  // Person fallback: no dept managers at all → creator manages this task
  const hasDept = await pool.query(
    `SELECT 1 FROM resource_dept_manage
     WHERE production_id=$1 AND resource_type='task' AND resource_id=$2 LIMIT 1`,
    [productionId, reqId],
  );
  if (hasDept.rows.length === 0) {
    // Also inherit event's person manager if present (bound tasks only)
    if (eventId) {
      await pool.query(
        `INSERT INTO resource_person_manage
           (production_id, user_id, resource_type, resource_id, established_by)
         SELECT production_id, user_id, 'task', $1, $2
         FROM resource_person_manage
         WHERE production_id = $3 AND resource_type = 'event' AND resource_id = $4
         ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub) DO NOTHING`,
        [reqId, createdBy, productionId, eventId],
      );
    }
    // If still nothing, creator is the manager
    const hasPerson = await pool.query(
      `SELECT 1 FROM resource_person_manage
       WHERE production_id=$1 AND resource_type='task' AND resource_id=$2 LIMIT 1`,
      [productionId, reqId],
    );
    if (hasPerson.rows.length === 0) {
      await pool.query(
        `INSERT INTO resource_person_manage
           (production_id, user_id, resource_type, resource_id, established_by)
         VALUES ($1,$2,'task',$3,$2)
         ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub) DO NOTHING`,
        [productionId, createdBy, reqId],
      );
    }
  }
}

export type CueListLevel = "manage" | "edit" | "mount" | "view";

/**
 * 批A：cue_list 伪级别 → 动词行集（授权面统一展开表）。
 * 非线性模型下"级别"只是授权 UX 的语言，蕴含由授权时发多行表达（总表 §0）。
 * selfConfirm / 直接授权 / 审批发行共用此表。
 */
export const CUE_LIST_LEVEL_ROW_SETS: Record<CueListLevel, ReadonlyArray<readonly [string, string]>> = {
  view:   [["*", "view"]],
  mount:  [["*", "view"], ["mounts", "create"]],
  edit:   [["*", "view"], ["*", "edit"], ["cues", "create"], ["cues", "delete"]],
  manage: [["*", "view"], ["*", "edit"], ["cues", "create"], ["cues", "delete"],
           ["*", "delete"], ["grants", "edit"]],
};

export type CueListAccessResult =
  | { canAccess: true; level: CueListLevel }
  | { canAccess: false; canSelfConfirm: true; selfConfirmLevel: "manage" | "edit" }
  | { canAccess: false; canSelfConfirm: false };

/**
 * Returns the highest active permission level for a user on a specific cue list,
 * or null if no active grant exists.
 */
export async function getCueListGrantLevel(
  userId: string,
  productionId: string,
  cueListId: string,
): Promise<CueListLevel | null> {
  // 批A REST 语义：从动词行推导 UI 伪级别（manage=grants edit；edit=覆盖 cues 的
  // edit；view=meta/cues view）。伪级别仅为前端展示兼容，检查本体是动词行。
  const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
    `SELECT rg.resource_sub, rg.permission_level
     FROM production_member_grant rg
     WHERE rg.production_id = $1
       AND rg.user_id = $2
       AND rg.resource_type = 'cue_list'
       AND rg.resource_id IN ($3, '*')
       AND NOT rg.is_revoked
       AND (rg.expires_at IS NULL OR rg.expires_at > NOW())`,
    [productionId, userId, cueListId],
  );
  const has = (sub: string[], verb: string) =>
    rows.some((r) => sub.includes(r.resource_sub) && r.permission_level === verb);
  if (has(["grants"], "edit")) return "manage";
  if (has(["cues", "*"], "edit")) return "edit";
  if (has(["meta", "cues", "*"], "view")) return "view";
  return null;
}

/**
 * Checks whether user is in the free-approval zone for a given level on a cue list.
 *
 * 批A（六步链 §0.8）：
 *   edit 档 = production_dept_permission 节点行（zone 键与 grant 键同词汇；
 *             POC 兜底保留——管理部门的 POC 天然有 edit 资格）
 *   manage 档 = 管理 dept 的 POC（代码规则；模板行不区分 POC，已知例外记总表）
 */
export async function checkCueListFreeApprovalZone(
  userId: string,
  productionId: string,
  cueListId: string,
  level: "edit" | "manage",
): Promise<boolean> {
  if (level === "manage") {
    const { rows } = await getPool().query(
      `SELECT 1
       FROM resource_dept_manage rdm
       JOIN production_dept_member pdm ON pdm.dept_id = rdm.dept_id
       WHERE rdm.production_id = $1
         AND rdm.resource_type = 'cue_list'
         AND rdm.resource_id = $2
         AND pdm.user_id = $3
         AND pdm.is_poc = true
       LIMIT 1`,
      [productionId, cueListId, userId],
    );
    return rows.length > 0;
  }

  // edit 档：dept 节点行（含通配）∪ 管理 dept 的 POC
  const editKeys = [
    `node:cue_list/${cueListId}@edit`,
    `node:cue_list/*@edit`,
  ];
  const { rows } = await getPool().query(
    `SELECT 1
     FROM production_dept_member pdm
     WHERE pdm.production_id = $1
       AND pdm.user_id = $2
       AND (
         EXISTS (
           SELECT 1 FROM production_dept_permission pdp
           WHERE pdp.dept_id = pdm.dept_id AND pdp.permission_key = ANY($4)
         )
         OR (pdm.is_poc AND EXISTS (
           SELECT 1 FROM resource_dept_manage rdm
           WHERE rdm.production_id = $1
             AND rdm.resource_type = 'cue_list'
             AND rdm.resource_id = $3
             AND rdm.dept_id = pdm.dept_id
         ))
       )
     LIMIT 1`,
    [productionId, userId, cueListId, editKeys],
  );
  return rows.length > 0;
}

/**
 * Writes a self_confirmed production_member_grant for the user on a cue list.
 * Idempotent: ON CONFLICT DO NOTHING (active-grant unique index).
 */
export async function selfConfirmCueListGrant(
  userId: string,
  productionId: string,
  cueListId: string,
  level: "edit" | "manage",
): Promise<void> {
  // 批A：自我确认写动词行集（非线性——edit 集含 view；manage 集另含 delete+grants）
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     SELECT $1, $2, 'cue_list', $3, s.sub, s.verb, 'self_confirmed', $2
     FROM (VALUES ('*', 'view'), ('*', 'edit'), ('cues', 'create'), ('cues', 'delete')) AS s(sub, verb)
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
       WHERE is_revoked = false
     DO NOTHING`,
    [productionId, userId, cueListId],
  );
  if (level === "manage") {
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       SELECT $1, $2, 'cue_list', $3, s.sub, s.verb, 'self_confirmed', $2
       FROM (VALUES ('*', 'delete'), ('grants', 'edit')) AS s(sub, verb)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [productionId, userId, cueListId],
    );
  }
}

/**
 * Full access check for a cue list:
 *   1. Active grant found → { canAccess: true, level }
 *   2. In manage free-approval zone → { canAccess: false, canSelfConfirm: true, selfConfirmLevel: 'manage' }
 *   3. In edit free-approval zone → { canAccess: false, canSelfConfirm: true, selfConfirmLevel: 'edit' }
 *   4. No zone → { canAccess: false, canSelfConfirm: false }
 */
export async function getCueListAccess(
  userId: string,
  productionId: string,
  cueListId: string,
): Promise<CueListAccessResult> {
  const level = await getCueListGrantLevel(userId, productionId, cueListId);
  if (level) return { canAccess: true, level };

  const [canManage, canEdit] = await Promise.all([
    checkCueListFreeApprovalZone(userId, productionId, cueListId, "manage"),
    checkCueListFreeApprovalZone(userId, productionId, cueListId, "edit"),
  ]);
  if (canManage) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "manage" };
  if (canEdit)   return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "edit" };
  return { canAccess: false, canSelfConfirm: false };
}

/**
 * Returns all active production_member_grant rows for a cue list, with user display name.
 * Used for the collaborator management panel.
 */
export async function listCueListGrants(
  cueListId: string,
): Promise<Array<{ userId: string; userName: string; level: CueListLevel }>> {
  // 批A：从动词行推导每人伪级别（manage=grants edit > edit=cues edit > view）
  const { rows } = await getPool().query<{ user_id: string; user_name: string; resource_sub: string; permission_level: string }>(
    `SELECT rg.user_id, COALESCE(up.name, rg.user_id::text) AS user_name,
            rg.resource_sub, rg.permission_level
     FROM production_member_grant rg
     LEFT JOIN user_profile up ON up.user_id = rg.user_id
     WHERE rg.resource_type = 'cue_list'
       AND rg.resource_id = $1
       AND NOT rg.is_revoked
       AND (rg.expires_at IS NULL OR rg.expires_at > NOW())`,
    [cueListId],
  );
  const byUser = new Map<string, { userName: string; subs: Array<{ sub: string; verb: string }> }>();
  for (const r of rows) {
    const e = byUser.get(r.user_id) ?? { userName: r.user_name, subs: [] };
    e.subs.push({ sub: r.resource_sub, verb: r.permission_level });
    byUser.set(r.user_id, e);
  }
  const rank: Record<CueListLevel, number> = { manage: 3, edit: 2, mount: 1, view: 0 };
  const out: Array<{ userId: string; userName: string; level: CueListLevel }> = [];
  for (const [userId, e] of byUser) {
    const has = (subs: string[], verb: string) =>
      e.subs.some((s) => subs.includes(s.sub) && s.verb === verb);
    let level: CueListLevel | null = null;
    if (has(["grants"], "edit")) level = "manage";
    else if (has(["cues", "*"], "edit")) level = "edit";
    else if (has(["meta", "cues", "*"], "view")) level = "view";
    if (level) out.push({ userId, userName: e.userName, level });
  }
  return out.sort((a, b) => rank[b.level] - rank[a.level] || a.userId.localeCompare(b.userId));
}

/**
 * Returns all resource_dept_manage entries for a cue list (which depts are in the free-approval zone).
 */
export async function listCueListDeptAccess(
  cueListId: string,
): Promise<Array<{ deptId: string; deptName: string }>> {
  const { rows } = await getPool().query<{ dept_id: string; dept_name: string }>(
    `SELECT rdm.dept_id, pd.name AS dept_name
     FROM resource_dept_manage rdm
     JOIN production_dept pd ON pd.id = rdm.dept_id
     WHERE rdm.resource_type = 'cue_list' AND rdm.resource_id = $1
     ORDER BY pd.name`,
    [cueListId],
  );
  return rows.map((r) => ({ deptId: r.dept_id, deptName: r.dept_name }));
}

/**
 * Adds a resource_dept_manage entry for a dept on a cue list (idempotent).
 */
export async function addCueListDeptAccess(
  cueListId: string,
  productionId: string,
  deptId: string,
  establishedBy: string,
): Promise<void> {
  // dept 分享 = 归属（rdm，审批人/POC manage 档）+ zone 资格（dept_permission
  // 实例级 edit 行集，成员经六步链第 3 步自我确认落 grant）
  await getPool().query(
    `INSERT INTO resource_dept_manage
       (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
     VALUES ($1, $2, 'cue_list', $3, '*', $4)
     ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING`,
    [productionId, deptId, cueListId, establishedBy],
  );
  await getPool().query(
    `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
     SELECT $1, $2, unnest(ARRAY[
       'node:cue_list/' || $3 || '@view',
       'node:cue_list/' || $3 || '@edit',
       'node:cue_list/' || $3 || '/cues@create',
       'node:cue_list/' || $3 || '/cues@delete'
     ]) ON CONFLICT (dept_id, permission_key) DO NOTHING`,
    [productionId, deptId, cueListId],
  );
}

/**
 * Removes a resource_dept_manage entry for a dept on a cue list.
 */
export async function removeCueListDeptAccess(
  cueListId: string,
  productionId: string,
  deptId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM resource_dept_manage
     WHERE resource_type = 'cue_list' AND resource_id = $1 AND dept_id = $2`,
    [cueListId, deptId],
  );
  // 撤 zone 资格行，并对该 dept 成员立即重算存续（资格消失 → self_confirmed 行收走，
  // 不等下次偶然的 role/dept 变动）
  await getPool().query(
    `DELETE FROM production_dept_permission
     WHERE dept_id = $1 AND permission_key LIKE 'node:cue_list/' || $2 || '%'`,
    [deptId, cueListId],
  );
  const { rows: members } = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM production_dept_member WHERE dept_id = $1`,
    [deptId],
  );
  const { recomputeAndRevokeGrants } = await import("./dept-db");
  for (const m of members) {
    await recomputeAndRevokeGrants(m.user_id, productionId, "dept_change");
  }
}

/**
 * Grants or revokes a user's direct access to a cue list at a specific level.
 * grant=true  → upsert production_member_grant(level, direct)
 * grant=false/null → revoke ALL active grants for this user on this cue list
 */
export async function setCueListGrant(
  cueListId: string,
  productionId: string,
  userId: string,
  grant: boolean | null,
  grantedBy: string,
  level: CueListLevel = "edit",
): Promise<void> {
  if (grant === true) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE production_member_grant
         SET is_revoked = true, revoked_reason = 'manual'
         WHERE production_id = $1 AND user_id = $2
           AND resource_type = 'cue_list' AND resource_id = $3
           AND NOT is_revoked`,
        [productionId, userId, cueListId],
      );
      // 批A：按伪级别写动词行集（direct 授权不受 dept/role sweep 影响）
      for (const [sub, verb] of CUE_LIST_LEVEL_ROW_SETS[level] ?? CUE_LIST_LEVEL_ROW_SETS.edit) {
        await client.query(
          `INSERT INTO production_member_grant
             (production_id, user_id, resource_type, resource_id, resource_sub,
              permission_level, grant_source, confirmed_by)
           VALUES ($1, $2, 'cue_list', $3, $4, $5, 'direct', $6)`,
          [productionId, userId, cueListId, sub, verb, grantedBy],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else {
    await getPool().query(
      `UPDATE production_member_grant
       SET is_revoked = true, revoked_reason = 'manual'
       WHERE production_id = $1
         AND user_id = $2
         AND resource_type = 'cue_list'
         AND resource_id = $3
         AND NOT is_revoked`,
      [productionId, userId, cueListId],
    );
  }
}
