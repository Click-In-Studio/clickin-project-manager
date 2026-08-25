/**
 * 审批路由（#140）—— 「谁来批这条申请」的唯一来源。
 *
 * 此前路由逻辑在 lib/db.ts 里写了三遍（findResourceApprovers 发通知用、
 * listPendingApprovals 的 SQL 收件箱用、isApprover 的鉴权用），改一处漏两处。
 * 现在改为：**只在此模块算一次**，算完把当前级审批人写进
 * approval_request.current_approver_ids，收件箱与鉴权都只读那一列。
 *
 * 阶梯（PRD-personnel-dept-v2「审批路由」章，2026-08-17 用户定谳按此实现）：
 *
 *   直属上级链（逐级向上，上级持有该权限才能终局，否则只能转发）
 *     → 资源持有者（该实例 grants@edit 行，总表 §0.10 持有者判据）
 *     → 共管部门 POC（resource_dept_manage / resource_person_manage）
 *     → 父部门 POC（逐级向上）
 *     → 制作人
 *     → Production Owner（必然存在，最终兜底）
 *
 * 治理域分流（批F 三态语义，见 grant-template.ts）：
 *   ROOT      —— owner-only，连审批通道都没有 → 申请直接拒收
 *   SENSITIVE —— 跳过整条链，直达 owner（制作人也批不了）
 */

import { getPool } from "./pg";
import { type ApprovalNodeClass, type ApprovalStageName, STAGE_ORDER } from "./approval-stages";
import { hasGrant } from "./grant-check";
import { isRootNode, isSensitiveNode } from "./grant-template";
import { loadDeptTree, collectAncestors } from "./dept-db";
import {
  CUE_LIST_LEVEL_ROW_SETS, EVENT_LEVEL_ROW_SETS, TASK_LEVEL_ROW_SETS,
  REPORT_LEVEL_ROW_SETS, NOTE_LEVEL_ROW_SETS, WIKI_LEVEL_ROW_SETS,
} from "./resource-grant-db";

// ─── 伪级别 → 动词行集 ────────────────────────────────────────────────────────

const LEVEL_ROW_SETS_BY_TYPE: Record<string, Record<string, ReadonlyArray<readonly [string, string]>>> = {
  cue_list: CUE_LIST_LEVEL_ROW_SETS,
  event:    EVENT_LEVEL_ROW_SETS,
  task:     TASK_LEVEL_ROW_SETS,
  report:   REPORT_LEVEL_ROW_SETS,
  note:     NOTE_LEVEL_ROW_SETS,
  wiki:     WIKI_LEVEL_ROW_SETS,
};

/**
 * 申请的 (resource_sub, permission_level) 展开成实际要发的动词行集。
 * REST 化域的伪级别（cue_list 的 'manage' 等）展开为多行；未迁移域按单行。
 * 授权发行与「上级有没有这个权限」的判定共用此表——两侧不会漂移。
 *
 * **只有 sub='*' 的申请才查伪级别表**：节点键申请（`cue_list/<id>/cues@edit`）
 * 带具体 sub，是动词形，要的就是那一行。动词 'edit' 与伪级别 'edit' 同名，
 * 不看 sub 就查表会把一条 cues@edit 申请发成整套 edit 级行集（含 delete）。
 */
export function expandLevelRows(
  resourceType: string,
  resourceSub: string,
  permissionLevel: string,
): ReadonlyArray<readonly [string, string]> {
  if (resourceSub !== "*") return [[resourceSub, permissionLevel] as const];
  return LEVEL_ROW_SETS_BY_TYPE[resourceType]?.[permissionLevel]
    ?? [[resourceSub, permissionLevel] as const];
}

// ─── 治理域分类 ───────────────────────────────────────────────────────────────

/** 与 ApprovalNodeClass 同一个类型：治理域三态只有一处定义，见 lib/approval-stages.ts。 */
export type NodeClass = ApprovalNodeClass;

export function classifyApprovalNode(
  resourceType: string,
  resourceSub: string,
  permissionLevel: string,
): NodeClass {
  if (isRootNode(resourceType, resourceSub, permissionLevel)) return "root";
  if (isSensitiveNode(resourceType, resourceSub, permissionLevel)) return "sensitive";
  return "normal";
}

// ─── 阶梯 ─────────────────────────────────────────────────────────────────────

// 级名、顺序与展示文案都在 lib/approval-stages.ts —— 那个模块不碰 pg，前端也引得动。
// 这里只做转出，好让既有 import 路径不用全仓改。
export type { ApprovalStageName } from "./approval-stages";
export { STAGE_ORDER } from "./approval-stages";

export type ApprovalStage = {
  stage: ApprovalStageName;
  /** 同一 stage 内的层级：supervisor 第几跳 / 祖先部门第几层，从 0 起。 */
  depth: number;
  approverIds: string[];
  /**
   * 本级审批人批准后是否直接发授权。
   * supervisor 级：仅当该上级本人持有申请的全部动词行时为 true（#140「上级有该权限
   * → 可批准；无该权限 → 只能向上转发」）；其余级恒 true。
   */
  canFinalize: boolean;
};

export type ApprovalTarget = {
  productionId: string;
  subjectId: string;
  resourceType: string;
  resourceId: string;
  resourceSub: string;
  permissionLevel: string;
};

/**
 * production_approval_config.ttl_hours 的列默认值——缺配置行时按此计时。
 *
 * 放在路由模块而不是各自的 db 文件里：权限申请与支出审批共用同一套超时升级语义，
 * 两处各存一份就会漂（原注释写的「改要同改」正是这个味道）。
 * 与 db/add-approval-config-backfill.sql 里插入的 24 是同一个值。
 */
export const DEFAULT_APPROVAL_TTL_HOURS = 24;

/** supervisor 链的最大跳数——防成环/防病态深链把通知打爆。 */
const MAX_SUPERVISOR_HOPS = 8;

/** 祖先部门的最大层数——同上。 */
const MAX_ANCESTOR_LEVELS = 8;

/**
 * 算出这条申请的完整升级阶梯。每次路由/升级都重算，好让期间的人事变动
 * （换 POC、调上级、部门改挂）立刻生效。
 *
 * 返回的每一级 approverIds 非空、已去重，且不含申请人本人；
 * 前面级已通知过的人不会在后面级重复出现（重复只会让升级空转）。
 */
export async function buildApprovalLadder(t: ApprovalTarget): Promise<ApprovalStage[]> {
  const cls = classifyApprovalNode(t.resourceType, t.resourceSub, t.permissionLevel);
  const ownerId = await findProductionOwner(t.productionId);

  // ROOT：owner-only 且无审批通道——调用侧应在提交时就拒收，这里兜底返回空阶梯。
  if (cls === "root") return [];

  // SENSITIVE：跳过整条链，直达 owner（制作人也不能代批）。
  if (cls === "sensitive") {
    return ownerId && ownerId !== t.subjectId
      ? [{ stage: "owner", depth: 0, approverIds: [ownerId], canFinalize: true }]
      : [];
  }

  const raw: ApprovalStage[] = [];

  // ① 直属上级链
  for (const hop of await walkSupervisorChain(t.productionId, t.subjectId)) {
    raw.push({
      stage: "supervisor",
      depth: hop.depth,
      approverIds: [hop.userId],
      canFinalize: hop.userId === ownerId || await holdsRequestedRows(hop.userId, t),
    });
  }

  // ② 资源持有者（该实例 grants@edit）
  raw.push({ stage: "holder", depth: 0, approverIds: await findResourceHolders(t), canFinalize: true });

  // ③ 共管部门 POC + 个人负责人
  const managingDeptIds = await findManagingDeptIds(t);
  const deptPocs = await findPocUserIds(t.productionId, managingDeptIds);
  const personManagers = await findPersonManagers(t);
  raw.push({
    stage: "dept_poc", depth: 0,
    approverIds: [...deptPocs, ...personManagers],
    canFinalize: true,
  });

  // ④ 父部门 POC（逐级向上）
  for (const level of await ancestorPocLevels(t.productionId, managingDeptIds)) {
    raw.push({ stage: "ancestor_poc", depth: level.depth, approverIds: level.userIds, canFinalize: true });
  }

  // ⑤ 制作人
  raw.push({ stage: "producer", depth: 0, approverIds: await findProducers(t.productionId), canFinalize: true });

  // ⑥ Owner 兜底
  raw.push({ stage: "owner", depth: 0, approverIds: ownerId ? [ownerId] : [], canFinalize: true });

  return dedupeLadder(raw, t.subjectId);
}

/** 去掉申请人本人、跨级去重、丢掉空级。 */
function dedupeLadder(ladder: ApprovalStage[], subjectId: string): ApprovalStage[] {
  const seen = new Set<string>([subjectId]);
  const out: ApprovalStage[] = [];
  for (const s of ladder) {
    const ids = [...new Set(s.approverIds)].filter((id) => !seen.has(id));
    if (ids.length === 0) continue;
    ids.forEach((id) => seen.add(id));
    out.push({ ...s, approverIds: ids });
  }
  return out;
}

export type StagePosition = { stage: ApprovalStageName; depth: number };

function positionRank(p: StagePosition): number {
  return STAGE_ORDER.indexOf(p.stage) * 1000 + p.depth;
}

/**
 * 阶梯中 current 之后的第一级。current 为 null 时给第一级。
 *
 * 用「阶梯序 + 层深」比较而非数组下标：两次调用之间阶梯形状可能变
 * （新增部门层级、上级换人），下标会错位，序号不会——升级始终单调向前。
 */
export function nextStage(ladder: ApprovalStage[], current: StagePosition | null): ApprovalStage | null {
  if (!current) return ladder[0] ?? null;
  const rank = positionRank(current);
  return ladder.find((s) => positionRank(s) > rank) ?? null;
}

/** 找到阶梯中与 current 对应的那一级（用于重算 canFinalize）。 */
export function stageAt(ladder: ApprovalStage[], current: StagePosition): ApprovalStage | null {
  return ladder.find((s) => s.stage === current.stage && s.depth === current.depth) ?? null;
}

/** 现有两值 status 的映射：supervisor 级 → pending_supervisor，其余 → pending_resource。 */
export function stageStatus(stage: ApprovalStageName): "pending_supervisor" | "pending_resource" {
  return stage === "supervisor" ? "pending_supervisor" : "pending_resource";
}

// ─── 各级人选查询 ─────────────────────────────────────────────────────────────

async function findProductionOwner(productionId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ owner_id: string }>(
    `SELECT owner_id FROM production WHERE id = $1`,
    [productionId],
  );
  return rows[0]?.owner_id ?? null;
}

/**
 * 从申请人出发逐级向上取直属上级；成环或超深即停。
 *
 * 导出给成员退出路由（#141）复用：退出的收件人阶梯与审批阶梯同源，
 * 「谁是我上级」不能有第二份实现。
 */
export async function walkSupervisorChain(
  productionId: string,
  subjectId: string,
): Promise<{ userId: string; depth: number }[]> {
  const out: { userId: string; depth: number }[] = [];
  const visited = new Set<string>([subjectId]);
  let cursor = subjectId;
  for (let depth = 0; depth < MAX_SUPERVISOR_HOPS; depth++) {
    const { rows } = await getPool().query<{ supervisor_id: string | null }>(
      `SELECT supervisor_id FROM production_member
       WHERE production_id = $1 AND user_id = $2`,
      [productionId, cursor],
    );
    const next = rows[0]?.supervisor_id ?? null;
    if (!next || visited.has(next)) break;
    visited.add(next);
    out.push({ userId: next, depth });
    cursor = next;
  }
  return out;
}

/** 该用户是否已持有申请要的**全部**动词行——决定上级能终局还是只能转发。 */
async function holdsRequestedRows(userId: string, t: ApprovalTarget): Promise<boolean> {
  const rows = expandLevelRows(t.resourceType, t.resourceSub, t.permissionLevel);
  for (const [sub, verb] of rows) {
    // 动词闭集之外的伪级别（未迁移域的 'manage' 等）无法用行判定回答，
    // 一律按「无权」处理 → 只能转发，不会误放行。
    if (!["view", "create", "edit", "delete"].includes(verb)) return false;
    const ok = await hasGrant(userId, t.productionId, t.resourceType, t.resourceId, sub, verb as "view" | "create" | "edit" | "delete");
    if (!ok) return false;
  }
  return true;
}

/**
 * 资源持有者：该实例 grants@edit 行的持有人（总表 §0.10）。
 * 结构性资源（scene/character/script 等）无 grants 段，这级自然为空、被跳过。
 */
async function findResourceHolders(t: ApprovalTarget): Promise<string[]> {
  const { rows } = await getPool().query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM production_member_grant
     WHERE production_id = $1
       AND resource_type = $2
       AND resource_id IN ($3, '*')
       AND resource_sub = 'grants'
       AND permission_level = 'edit'
       AND NOT is_revoked
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [t.productionId, t.resourceType, t.resourceId],
  );
  return rows.map((r) => r.user_id);
}

async function findManagingDeptIds(t: ApprovalTarget): Promise<string[]> {
  const { rows } = await getPool().query<{ dept_id: string }>(
    `SELECT DISTINCT dept_id FROM resource_dept_manage
     WHERE production_id = $1
       AND resource_type = $2
       AND (resource_id = $3 OR resource_id = '*')
       AND (resource_sub = $4 OR resource_sub = '*')`,
    [t.productionId, t.resourceType, t.resourceId, t.resourceSub],
  );
  return rows.map((r) => r.dept_id);
}

async function findPocUserIds(productionId: string, deptIds: string[]): Promise<string[]> {
  if (deptIds.length === 0) return [];
  const { rows } = await getPool().query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM production_dept_member
     WHERE production_id = $1 AND dept_id = ANY($2::uuid[]) AND is_poc = true`,
    [productionId, deptIds],
  );
  return rows.map((r) => r.user_id);
}

async function findPersonManagers(t: ApprovalTarget): Promise<string[]> {
  const { rows } = await getPool().query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM resource_person_manage
     WHERE production_id = $1
       AND resource_type = $2
       AND (resource_id = $3 OR resource_id = '*')
       AND (resource_sub = $4 OR resource_sub = '*')`,
    [t.productionId, t.resourceType, t.resourceId, t.resourceSub],
  );
  return rows.map((r) => r.user_id);
}

/** 共管部门的祖先部门 POC，按层聚合：第 0 层=直接父部门，依次向上。 */
async function ancestorPocLevels(
  productionId: string,
  managingDeptIds: string[],
): Promise<{ depth: number; userIds: string[] }[]> {
  if (managingDeptIds.length === 0) return [];
  const tree = await loadDeptTree(productionId);
  const byLevel: string[][] = [];
  for (const deptId of managingDeptIds) {
    collectAncestors(deptId, tree).slice(0, MAX_ANCESTOR_LEVELS).forEach((ancestorId, i) => {
      (byLevel[i] ??= []).push(ancestorId);
    });
  }

  const out: { depth: number; userIds: string[] }[] = [];
  for (let depth = 0; depth < byLevel.length; depth++) {
    const userIds = await findPocUserIds(productionId, [...new Set(byLevel[depth] ?? [])]);
    if (userIds.length > 0) out.push({ depth, userIds });
  }
  return out;
}

/**
 * 制作人：结构性角色，名称不可改不可删（lib/db.ts setMemberRoles 守卫），按名匹配安全。
 *
 * 导出是为了让「谁能配资源审批人」（#262，app/api/.../resource-approvers）用同一份判据：
 * 制作人身份在别处再按名查一次，'制作人' 这个字面量就有了第二处真相。
 */
export async function findProducers(productionId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM production_member
     WHERE production_id = $1 AND '制作人' = ANY(roles) AND status = 'active'`,
    [productionId],
  );
  return rows.map((r) => r.user_id);
}
