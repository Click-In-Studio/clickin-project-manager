/**
 * 资源访问申请（approval_request）的**读模型**。
 *
 * 这里回答「一条申请长什么样、谁能看、看到什么」：行 → 领域对象的映射、链上人员的
 * 姓名/角色填充、鉴权判定、我的申请 / 我的待办、提交前的阶梯预览、实例流程视图。
 * 收件箱（listPendingApprovals）与鉴权（authorizeApprovalAction）只读写入时算好的
 * current_approver_ids，不各自重算路由（#140 了结的三处漂移）。
 *
 * 不在这里：改状态的动作（提交 / 批准 / 转交 / 拒绝 / 撤回 / 超时升级）与通知投递，
 * 见 access-request-action-db.ts —— 它依赖本文件，本文件不依赖它。
 * 「谁来批」的阶梯算法在 approval-routing.ts，模版流引擎在 approval-flow-engine.ts。
 */
import { getPool } from "../pg";
import {
  buildApprovalLadder, classifyApprovalNode, findProductionOwner, nextStage, stageAt,
  type ApprovalStageName, type ApprovalTarget, type StagePosition,
} from "./approval-routing";
import { parseFlowSnapshot, resolveNodeAssignees, type FlowSnapshot } from "./approval-flow-engine";
import { STAGE_ORDER, type ApprovalAction, type ApprovalNodeClass } from "./approval-stages";

export type ApprovalRequest = {
  id: string;
  productionId: string;
  subjectId: string;
  subjectName?: string;
  type: string;
  resourceType: string | null;
  resourceId: string | null;
  resourceSub: string | null;
  permissionLevel: string | null;
  grantType: "permanent" | "ttl" | null;
  /**
   * 展示用中文串（"7天"），仅供渲染。**不是**提交侧的线格式——
   * SubmitAccessRequestParams.ttlDuration 要的是 Postgres INTERVAL 字面量
   * （"7 days"），两者不可互相回灌。要算剩余时长请用 expiresAt。
   */
  ttlDurationLabel: string | null;
  /** 自定义有效期在提交时选定的绝对到期时间；固定档位为 null。 */
  requestedExpiresAt: string | null;
  note: string | null;
  status: "pending_supervisor" | "pending_resource" | "approved" | "rejected" | "cancelled";
  escalationChain: ApprovalChainEntry[];
  /** 模版流实例快照（prB）；null = 阶梯流。前端时间线/流程视图据此渲染节点。 */
  flowSnapshot: FlowSnapshot | null;
  /** 当前审批阶梯级（#140）；已 resolve 的申请为 null。 */
  currentStage: ApprovalStageName | null;
  currentApproverIds: string[];
  /**
   * 当前查看者能否直接批准。false = 只能向上转发（直属上级本人没有这个权限）。
   * 由 listPendingApprovals 按级填充，其余读取路径为 null（不适用）。
   */
  canFinalize: boolean | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  /**
   * 这条申请里出现过的所有人（申请人、各级审批人候选、操作人、终结者）→ 姓名与角色。
   * 由 attachApprovalPeople 填充；未经该函数的读取路径为空对象，消费方按 ID 降级。
   */
  people: Record<string, ApprovalPerson>;
};

export type ApprovalChainEntry = {
  /** 旧两段式字段，保留给存量行与既有 UI；新写入按 stage 派生。 */
  phase: "supervisor" | "resource";
  /** #140 阶梯级名与层深（存量行无此字段）。 */
  stage?: ApprovalStageName;
  depth?: number;
  canFinalize?: boolean;
  approverIds: string[];
  notifiedAt: string;
  /** cancelled = 这一级还没处理，申请就被申请人撤回或被新申请顶掉了。 */
  action?: ApprovalAction;
  /**
   * 动作的操作人。**系统动作没有这个字段**（见 bySystem）——
   * 消费方不能把「有没有 actorId」当成「有没有发生过动作」来判。
   */
  actorId?: string;
  actedAt?: string;
  /**
   * 该动作由系统发起，没有操作人：超时自动升级、被新申请顶掉的旧申请。
   * 这个字段是补给前端的：此前超时升级只留下 escalationReason='timeout'
   * 而没有 actorId，UI 把「原因」挂在「操作人」下面渲染，于是最该说清楚的
   * 「没人处理，超时自动升上去了」反而一个字都显示不出来。
   */
  bySystem?: boolean;
  /** escalated 的原因：超时自动升级 / 审批人手动转发。 */
  escalationReason?: "timeout" | "forwarded";
  /** cancelled 的原因：申请人主动撤回 / 被同目标的新申请覆盖。 */
  cancelReason?: "by_subject" | "superseded" | "expired";
  /** 模版流（prB）扩展：该级对应的模版节点。时间线优先显示 nodeTitle 而非级名。 */
  nodeId?: string;
  nodeTitle?: string;
  /**
   * 审批意见：批准/拒绝/转交/撤回时写下的理由，随动作落在这一级上。
   *
   * 落在链条目而不是单开评论表：这是**审批决定的一部分**，跟着决定走、
   * 跟着决定不可变。真要做多人讨论区是另一回事（要作者、可见范围、附件），
   * 那时再单开表，不影响这里。
   */
  comment?: string;
};

/**
 * 审批链上出现过的人。**由读取路径按当前 user_profile 现算**，不是落库快照——
 * 姓名快照的收益（离职改名后历史不失真）撑不起每次升级多查一次名字的成本
 * （2026-08-25 用户定谳）。
 *
 * 有它之后前端不必再联查 /contacts 反查姓名：那条路既拉了全员邮箱手机号，
 * 又覆盖不到不在 production_member 里的审批人。
 */
export type ApprovalPerson = {
  userId: string;
  name: string;
  /** 该人在本演出的角色（不在本演出时为空数组）。 */
  roles: string[];
  /** false = 此人已不在（或从未在）本演出的成员名单里，但仍是链上的真实审批人。 */
  isMember: boolean;
};

export type ApprovalRow = {
  id: string;
  production_id: string;
  subject_id: string;
  subject_name?: string | null;
  type: string;
  resource_type: string | null;
  resource_id: string | null;
  resource_sub: string | null;
  permission_level: string | null;
  grant_type: string | null;
  ttl_duration: PgInterval | string | null;
  requested_expires_at: Date | null;
  note: string | null;
  status: string;
  escalation_chain: ApprovalChainEntry[];
  current_stage: string | null;
  current_stage_depth: number | null;
  current_approver_ids: string[] | null;
  /** 模版流实例快照（prB）；NULL = 阶梯流（存量与无模版项目）。 */
  flow_snapshot: FlowSnapshot | null;
  flow_template_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  granted_at: Date | null;
  expires_at: Date | null;
};

/**
 * node-postgres 把 INTERVAL 列解析成 postgres-interval 对象（如 '7 days' → { days: 7 }），
 * 不是字符串。裸传给前端会触发 "Objects are not valid as a React child"。
 */
export type PgInterval = {
  years?: number; months?: number; days?: number;
  hours?: number; minutes?: number; seconds?: number; milliseconds?: number;
};

// 必须覆盖 PgInterval 的每个字段：漏一个就是静默丢数据。
// 例：'1.5 seconds'::interval → { seconds: 1, milliseconds: 500 }，
// 漏掉 milliseconds 会渲染成 "1秒"；'500 ms' 更会整条塌成 null。
const INTERVAL_UNITS: [keyof PgInterval, string][] = [
  ["years", "年"], ["months", "个月"], ["days", "天"],
  ["hours", "小时"], ["minutes", "分钟"], ["seconds", "秒"], ["milliseconds", "毫秒"],
];

export function formatPgInterval(v: PgInterval | string | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;  // 兼容 type parser 被改回字符串的情况
  const parts = INTERVAL_UNITS
    .filter(([k]) => typeof v[k] === "number" && v[k] !== 0)
    .map(([k, label]) => `${v[k]}${label}`);
  return parts.join("") || null;
}

export function rowToApproval(r: ApprovalRow): ApprovalRequest {
  return {
    id: r.id,
    productionId: r.production_id,
    subjectId: r.subject_id,
    subjectName: r.subject_name ?? undefined,
    type: r.type,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    resourceSub: r.resource_sub,
    permissionLevel: r.permission_level,
    grantType: (r.grant_type as "permanent" | "ttl" | null),
    ttlDurationLabel: formatPgInterval(r.ttl_duration),
    requestedExpiresAt: r.requested_expires_at ? r.requested_expires_at.toISOString() : null,
    note: r.note,
    status: r.status as ApprovalRequest["status"],
    escalationChain: r.escalation_chain ?? [],
    flowSnapshot: parseFlowSnapshot(r.flow_snapshot),
    currentStage: (r.current_stage as ApprovalStageName | null) ?? null,
    currentApproverIds: r.current_approver_ids ?? [],
    canFinalize: null,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    resolvedBy: r.resolved_by,
    grantedAt: r.granted_at ? r.granted_at.toISOString() : null,
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    people: {},
  };
}

/** 一条申请里出现过的全部用户 ID：申请人、各级候选审批人、操作人、终结者。 */
function collectApprovalUserIds(req: ApprovalRequest): string[] {
  const ids = new Set<string>([req.subjectId]);
  if (req.resolvedBy) ids.add(req.resolvedBy);
  req.currentApproverIds.forEach((id) => ids.add(id));
  for (const entry of req.escalationChain) {
    (entry.approverIds ?? []).forEach((id) => ids.add(id));
    if (entry.actorId) ids.add(entry.actorId);
  }
  return [...ids];
}

/**
 * 批量解析用户 ID → 姓名/角色。一次查完整批申请，不按条 N+1。
 *
 * 姓名口径与通知、财务、部门冻结一致：display_name 优先、退回 name。
 * **不 join feishu_user**（#234 身份债已清偿：显示名只走 user_profile）。
 * 查无此人（profile 行缺失）不返回条目，消费方按 ID 降级显示。
 */
async function loadApprovalPeople(
  productionId: string,
  userIds: string[],
): Promise<Record<string, ApprovalPerson>> {
  if (userIds.length === 0) return {};
  const { rows } = await getPool().query<{
    user_id: string; name: string | null; roles: string[] | null; is_member: boolean;
  }>(
    `SELECT up.user_id,
            COALESCE(NULLIF(up.display_name, ''), NULLIF(up.name, '')) AS name,
            pm.roles,
            (pm.user_id IS NOT NULL) AS is_member
     FROM user_profile up
     LEFT JOIN production_member pm
       ON pm.production_id = $2 AND pm.user_id = up.user_id
     WHERE up.user_id = ANY($1::uuid[])`,
    [userIds, productionId],
  );
  const out: Record<string, ApprovalPerson> = {};
  for (const r of rows) {
    if (!r.name) continue;  // 无名可显示时不如让消费方走自己的降级文案
    out[r.user_id] = {
      userId: r.user_id,
      name: r.name,
      roles: r.roles ?? [],
      isMember: r.is_member,
    };
  }
  return out;
}

/**
 * 给一批申请填 people。审批链上的人**不一定是 production_member**
 * （祖先部门 POC、存量演出的 owner 都可能不在名单里），所以这里按 user_profile
 * 取名、按 production_member 取角色，两者分开——用成员表 INNER JOIN 取名会让
 * 这些人整个消失（feedback_fixture_hides_prod 的同款坑）。
 */
async function attachApprovalPeople(requests: ApprovalRequest[]): Promise<ApprovalRequest[]> {
  if (requests.length === 0) return requests;
  // 同一次调用里所有申请都属同一个演出（列表接口按演出过滤），按演出分组兜底跨演出调用
  const byProduction = new Map<string, ApprovalRequest[]>();
  for (const req of requests) {
    const bucket = byProduction.get(req.productionId);
    if (bucket) bucket.push(req);
    else byProduction.set(req.productionId, [req]);
  }
  for (const [productionId, group] of byProduction) {
    const ids = [...new Set(group.flatMap(collectApprovalUserIds))];
    const people = await loadApprovalPeople(productionId, ids);
    for (const req of group) {
      req.people = Object.fromEntries(
        collectApprovalUserIds(req)
          .map((id) => [id, people[id]] as const)
          .filter((pair): pair is readonly [string, ApprovalPerson] => pair[1] !== undefined),
      );
    }
  }
  return requests;
}

/** 单条申请的 people 填充——动作接口回给前端的那条也要带人，否则页面刷新前是空的。 */
export async function withApprovalPeople(request: ApprovalRequest): Promise<ApprovalRequest> {
  const [filled] = await attachApprovalPeople([request]);
  return filled;
}

export function approvalTargetOf(req: ApprovalRow): ApprovalTarget {
  return {
    productionId:    req.production_id,
    subjectId:       req.subject_id,
    resourceType:    req.resource_type ?? "",
    resourceId:      req.resource_id ?? "*",
    resourceSub:     req.resource_sub ?? "*",
    permissionLevel: req.permission_level ?? "",
  };
}

export function currentPositionOf(req: ApprovalRow): StagePosition | null {
  return req.current_stage
    ? { stage: req.current_stage as ApprovalStageName, depth: req.current_stage_depth ?? 0 }
    : null;
}

export function isPendingStatus(status: string): boolean {
  return status === "pending_supervisor" || status === "pending_resource";
}

export async function loadApproval(requestId: string): Promise<ApprovalRow | null> {
  const { rows } = await getPool().query<ApprovalRow>(
    `SELECT * FROM approval_request WHERE id = $1`,
    [requestId],
  );
  return rows[0] ?? null;
}

/**
 * 审批动作鉴权。返回 canFinalize=false 表示「在场但只能转发」。
 *
 * owner 恒可介入；制作人可介入非敏感申请（PRD：制作人可随时介入本演出待处理
 * 申请）；敏感节点恒过 owner，制作人代批不了。
 */
export async function authorizeApprovalAction(
  req: ApprovalRow,
  actorId: string,
): Promise<{ authorized: boolean; canFinalize: boolean }> {
  const ownerRes = await getPool().query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM production WHERE id = $1 AND owner_id = $2) AS ok`,
    [req.production_id, actorId],
  );
  if (ownerRes.rows[0]?.ok) return { authorized: true, canFinalize: true };

  const nodeClass = classifyApprovalNode(
    req.resource_type ?? "", req.resource_sub ?? "*", req.permission_level ?? "",
  );
  if (nodeClass !== "sensitive") {
    const producerRes = await getPool().query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM production_member
         WHERE production_id = $1 AND user_id = $2 AND '制作人' = ANY(roles)
       ) AS ok`,
      [req.production_id, actorId],
    );
    if (producerRes.rows[0]?.ok) return { authorized: true, canFinalize: true };
  }

  if (!(req.current_approver_ids ?? []).includes(actorId)) {
    return { authorized: false, canFinalize: false };
  }
  // 非 supervisor 级恒可终局；supervisor 级按「本人是否持有该权限」现算
  if (req.current_stage !== "supervisor") return { authorized: true, canFinalize: true };

  const ladder = await buildApprovalLadder(approvalTargetOf(req));
  const stage = stageAt(ladder, { stage: "supervisor", depth: req.current_stage_depth ?? 0 });
  return { authorized: true, canFinalize: stage?.canFinalize ?? false };
}

export async function listMyAccessRequests(
  productionId: string,
  userId: string,
): Promise<ApprovalRequest[]> {
  const res = await getPool().query<ApprovalRow>(
    `SELECT ar.*, COALESCE(NULLIF(up.display_name, ''), up.name, '成员') AS subject_name
     FROM approval_request ar
     LEFT JOIN user_profile up ON up.user_id = ar.subject_id
     WHERE ar.production_id = $1 AND ar.subject_id = $2
     ORDER BY ar.created_at DESC`,
    [productionId, userId],
  );
  return attachApprovalPeople(res.rows.map(rowToApproval));
}

/**
 * 我的待办：只读 current_approver_ids（路由已在写入时算好）。
 * canFinalize 取自当前级的链条目——false 表示前端该显示「转发」而非「批准」。
 */
export async function listPendingApprovals(
  actorId: string,
  productionId?: string,
): Promise<ApprovalRequest[]> {
  const params: unknown[] = [actorId];
  const prodClause = productionId
    ? `AND ar.production_id = $${params.push(productionId)}`
    : "";

  const res = await getPool().query<ApprovalRow>(
    `SELECT ar.*, COALESCE(NULLIF(up.display_name, ''), up.name, '成员') AS subject_name
     FROM approval_request ar
     LEFT JOIN user_profile up ON up.user_id = ar.subject_id
     WHERE ar.status IN ('pending_supervisor', 'pending_resource')
       AND ar.current_approver_ids @> ARRAY[$1]::uuid[]
     ${prodClause}
     ORDER BY ar.created_at ASC`,
    params,
  );
  return attachApprovalPeople(res.rows.map((r) => {
    const approval = rowToApproval(r);
    const last = approval.escalationChain[approval.escalationChain.length - 1];
    return { ...approval, canFinalize: last?.canFinalize ?? true };
  }));
}

// ─── 审批链预览（提交前）────────────────────────────────────────────────────────

export type ApprovalLadderPreviewStage = {
  stage: ApprovalStageName;
  depth: number;
  /** 该级能否直接终局。false = 只能向上转交（直属上级本人没有这个权限）。 */
  canFinalize: boolean;
  approverIds: string[];
};

export type ApprovalLadderPreview = {
  /** root = 无审批通道（提交也会被拒收）；sensitive = 跳过整条链直达 owner。 */
  nodeClass: ApprovalNodeClass;
  stages: ApprovalLadderPreviewStage[];
  people: Record<string, ApprovalPerson>;
};

/**
 * 提交前预览这条申请会走的审批链。
 *
 * **这是预测不是快照**：阶梯由 buildApprovalLadder 按**此刻**的汇报关系、资源持有者、
 * 部门 POC 现算，真正提交后每次升级都会重算一遍。中间任何人事变动都会让实际链路
 * 与这份预览不同——消费方必须把它呈现为「预计」，不能当成承诺。
 *
 * nodeClass 是这个接口的另一半价值：ROOT 节点在提交时会被 no_entry 拒收，
 * 让人填完整张表才吃 403 是白填；预览一眼就能说清楚"这个权限没有申请通道"。
 */
export async function previewApprovalLadder(
  productionId: string,
  subjectId: string,
  params: { resourceType: string; resourceId?: string; resourceSub?: string; permissionLevel: string },
): Promise<ApprovalLadderPreview> {
  const target: ApprovalTarget = {
    productionId,
    subjectId,
    resourceType: params.resourceType,
    resourceId: params.resourceId ?? "*",
    resourceSub: params.resourceSub ?? "*",
    permissionLevel: params.permissionLevel,
  };
  const nodeClass = classifyApprovalNode(target.resourceType, target.resourceSub, target.permissionLevel);
  // ROOT 连审批通道都没有——buildApprovalLadder 对它返回空阶梯，不必白跑一趟查询
  const ladder = nodeClass === "root" ? [] : await buildApprovalLadder(target);

  const stages = ladder.map((s) => ({
    stage: s.stage, depth: s.depth, canFinalize: s.canFinalize, approverIds: s.approverIds,
  }));
  const people = await loadApprovalPeople(
    productionId,
    [...new Set(stages.flatMap((s) => s.approverIds))],
  );
  return { nodeClass, stages, people };
}


// ─── 实例流程视图（prB，缺口文档 P1-6）────────────────────────────────────────

export type AccessRequestFlowView = {
  request: ApprovalRequest;
  flow:
    | {
        mode: "template";
        /**
         * 未来节点的处理人**实时预测**（按当前组织关系现算，标注给前端展示用；
         * 引擎执行时仍按跳晚绑定重新解析——预测不是承诺，§4）。
         */
        prediction: { nodeId: string; approverIds: string[] }[];
      }
    | {
        mode: "ladder";
        /**
         * 当前级之后的真实剩余阶梯（空级已剔除、敏感项已分流）。#405 预测框用
         * STAGE_ORDER 裸切片显示引擎永远不会走的节点——这里是它的正解数据源。
         */
        remaining: { stage: ApprovalStageName; depth: number; approverIds: string[] }[];
      };
  viewerActions: { canApprove: boolean; canReject: boolean; canEscalate: boolean };
};

/**
 * 按 requestId 读取实例流程。preview 接口按 session 用户算组织链，审批人查看
 * 他人申请会得到错误的链（缺口文档 P1-6）——本接口按**申请主体**算，且经过
 * 实例可见性校验：申请人、链上出现过的人、当前处理人、owner、制作人、平台
 * 管理员可见；其余成员 403（流程配置与人员安排不是全员可见的数据）。
 */
export async function getAccessRequestFlow(
  requestId: string,
  viewerId: string,
  isPlatformAdmin: boolean,
): Promise<
  | { ok: true; view: AccessRequestFlowView }
  | { ok: false; reason: "not_found" | "forbidden" }
> {
  const row = await loadApproval(requestId);
  if (!row) return { ok: false, reason: "not_found" };

  const participants = new Set<string>([row.subject_id, ...(row.current_approver_ids ?? [])]);
  for (const entry of row.escalation_chain ?? []) {
    (entry.approverIds ?? []).forEach((id) => participants.add(id));
    if (entry.actorId) participants.add(entry.actorId);
  }
  if (row.resolved_by) participants.add(row.resolved_by);

  let visible = isPlatformAdmin || participants.has(viewerId);
  if (!visible) {
    const { rows } = await getPool().query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM production
         WHERE id = $1 AND owner_id = $2
         UNION
         SELECT 1 FROM production_member
         WHERE production_id = $1 AND user_id = $2 AND '制作人' = ANY(roles) AND status = 'active'
       ) AS ok`,
      [row.production_id, viewerId],
    );
    visible = rows[0]?.ok ?? false;
  }
  if (!visible) return { ok: false, reason: "forbidden" };

  const pending = isPendingStatus(row.status);
  const snapshot = parseFlowSnapshot(row.flow_snapshot);
  const target = approvalTargetOf(row);

  let flow: AccessRequestFlowView["flow"];
  if (snapshot) {
    const prediction: { nodeId: string; approverIds: string[] }[] = [];
    if (pending) {
      for (const node of snapshot.nodes) {
        if (node.state !== "pending" || node.type === "cc") continue;
        prediction.push({
          nodeId: node.id,
          approverIds: await resolveNodeAssignees(node, target),
        });
      }
    }
    flow = { mode: "template", prediction };
  } else {
    let remaining: { stage: ApprovalStageName; depth: number; approverIds: string[] }[] = [];
    if (pending) {
      const ladder = await buildApprovalLadder(target);
      const current = currentPositionOf(row);
      const currentRank = current
        ? STAGE_ORDER.indexOf(current.stage) * 1000 + current.depth
        : -1;
      remaining = ladder
        .filter((s) => STAGE_ORDER.indexOf(s.stage) * 1000 + s.depth > currentRank)
        .map((s) => ({ stage: s.stage, depth: s.depth, approverIds: s.approverIds }));
    }
    flow = { mode: "ladder", remaining };
  }

  let viewerActions = { canApprove: false, canReject: false, canEscalate: false };
  if (pending) {
    const auth = await authorizeApprovalAction(row, viewerId);
    if (auth.authorized) {
      const canEscalate = snapshot
        ? !(row.current_approver_ids ?? []).includes((await findProductionOwner(row.production_id)) ?? "")
        : nextStage(await buildApprovalLadder(target), currentPositionOf(row)) !== null;
      viewerActions = { canApprove: auth.canFinalize, canReject: true, canEscalate };
    }
  }

  // 预测/剩余阶梯里的人不在链上，withApprovalPeople 收不到——补齐 people
  // 映射，前端才能显示姓名而不是裸 ID（预测展示也要人话）。
  const request = await withApprovalPeople(rowToApproval(row));
  const forecastIds = flow.mode === "template"
    ? flow.prediction.flatMap((p) => p.approverIds)
    : flow.remaining.flatMap((s) => s.approverIds);
  const missing = [...new Set(forecastIds)].filter((uid) => !request.people[uid]);
  if (missing.length > 0) {
    Object.assign(request.people, await loadApprovalPeople(row.production_id, missing));
  }

  return {
    ok: true,
    view: { request, flow, viewerActions },
  };
}
