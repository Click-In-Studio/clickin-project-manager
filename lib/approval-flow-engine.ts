/**
 * 审批流程模版引擎（prB）。设计：docs/approval-flow-template-design-2026-09-03.md。
 *
 * 单引擎双源：提交时「有已发布模版？」决定编译源——
 *   有  → 本模块把模版编译成 flow_snapshot（多节点，逐节点推进）；
 *   无  → flow_snapshot 为 NULL，lib/db.ts 走原封不动的阶梯路径。
 * 存量在途行天然 NULL = 懒编译（其实是零编译）：不回填、零行为变化。
 *
 * 两段式快照（§4）：
 *   结构在提交时定格（模版中途改动不影响在途实例）；
 *   人按跳晚绑定——进入节点那一刻才解析（resolveNodeAssignees），已通知即定格。
 *
 * 节点 = 升级链容器（§2）的 v1 裁剪：模版节点内部无升级链，超时/手动转交
 * 一律落到 owner 兜底（节点内事件，不换节点）；空处理人按 optional 二值：
 * 跳过 或 兜底 owner。
 *
 * 分层纪律：本模块不发通知（返回 FlowNotifyPlan 由 lib/db.ts 执行——通知文案、
 * 外部消息、user_notification 都在那边），不碰 grant 行（终局发行仍归
 * approveAccessRequest 的既有路径）。
 *
 * 模版流的行形态：status='pending_resource'、current_stage=NULL、
 * current_approver_ids=当前节点已解析的人。current_stage 恒 NULL 是有意的：
 * authorizeApprovalAction 只对 stage='supervisor' 做「持权才可终局」重算，
 * 模版里的直属上级节点语义是「审批完成推进下一节点」（字节风格），不适用
 * 阶梯的 forward-only 规则。
 */
import { getPool } from "./pg";
import {
  findManagingDeptIds,
  findPersonManagers,
  findPocUserIds,
  findProducers,
  findProductionOwner,
  findResourceHolders,
  walkSupervisorChain,
  classifyApprovalNode,
  type ApprovalTarget,
} from "./approval-routing";
import type { ApprovalStageName } from "./approval-stages";
import { DEFAULT_APPROVAL_TTL_HOURS } from "./approval-routing";
import type {
  ApprovalAssigneeSource,
  ApprovalTemplateNode,
  ApprovalTemplateNodeType,
} from "./approval-flow-template";

// ─── 快照结构 ─────────────────────────────────────────────────────────────────

export type FlowNodeState = "pending" | "active" | "done" | "skipped";

export type FlowSnapshotNode = {
  id: string;
  type: ApprovalTemplateNodeType;
  title: string;
  assigneeSource: ApprovalAssigneeSource;
  roleNames?: string[];
  memberIds?: string[];
  timeoutHours: number | null;
  optional: boolean;
  state: FlowNodeState;
  enteredAt?: string;
  completedAt?: string;
  /** 晚绑定：进入节点时解析出的人（审计；current_approver_ids 与之同步）。 */
  resolvedApproverIds?: string[];
  /** 兜底 owner 生效（原始来源解析为空且 optional=false）。 */
  ownerFallback?: boolean;
  /**
   * v1 单条（或签任一人完成即节点完成）；数组结构为会签的独立记录预留
   * ——设计文档 §6，字段形状是快照契约的一部分，扩容不迁移。
   */
  responses?: { userId: string; action: "approved" | "completed"; actedAt: string; comment?: string }[];
  /** cc 节点：投递到的人（到达即投递不等待）。 */
  deliveredTo?: string[];
  skippedReason?: "empty_assignees" | "timeout";
};

export type FlowSnapshot = {
  v: 1;
  templateId: string;
  templateName: string;
  nodes: FlowSnapshotNode[];
  /** 当前活动节点下标；全部走完 = nodes.length。 */
  cursor: number;
};

/** 引擎要求的行子集（结构兼容 lib/db.ts 的 ApprovalRow，避免反向 import 成环）。 */
export type FlowRequestRow = {
  id: string;
  production_id: string;
  subject_id: string;
  resource_type: string | null;
  resource_id: string | null;
  resource_sub: string | null;
  permission_level: string | null;
  status: string;
  current_approver_ids: string[] | null;
  flow_snapshot: FlowSnapshot | null;
};

/** 通知计划：由 lib/db.ts 执行（文案与投递渠道都在那边，引擎不碰）。 */
export type FlowNotifyPlan =
  | {
      kind: "node_pending";
      nodeId: string;
      nodeTitle: string;
      nodeType: "approval" | "processing";
      approverIds: string[];
      context: "new" | "timeout" | "forwarded";
      handoffComment?: string | null;
    }
  | { kind: "cc"; nodeId: string; nodeTitle: string; recipientIds: string[] };

export function parseFlowSnapshot(raw: unknown): FlowSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as FlowSnapshot;
  if (s.v !== 1 || !Array.isArray(s.nodes) || typeof s.cursor !== "number") return null;
  return s;
}

// ─── 人选解析（晚绑定） ────────────────────────────────────────────────────────

/**
 * 规则 → 人。进入节点/兜底切换那一刻调用，不提前、不缓存（§4 晚绑定）。
 * 恒排除申请人本人、去重；不含成员在职过滤的来源（specific_members）补一道
 * active 校验——离场成员的待办没人能处理。
 */
export async function resolveNodeAssignees(
  node: Pick<FlowSnapshotNode, "assigneeSource" | "roleNames" | "memberIds">,
  t: ApprovalTarget,
): Promise<string[]> {
  let ids: string[] = [];
  switch (node.assigneeSource) {
    case "supervisor": {
      const chain = await walkSupervisorChain(t.productionId, t.subjectId);
      ids = chain.length > 0 ? [chain[0].userId] : [];
      break;
    }
    case "holder":
      ids = await findResourceHolders(t);
      break;
    case "dept_poc": {
      const deptIds = await findManagingDeptIds(t);
      ids = [...(await findPocUserIds(t.productionId, deptIds)), ...(await findPersonManagers(t))];
      break;
    }
    case "producer":
      ids = await findProducers(t.productionId);
      break;
    case "owner": {
      const ownerId = await findProductionOwner(t.productionId);
      ids = ownerId ? [ownerId] : [];
      break;
    }
    case "project_role": {
      const { rows } = await getPool().query<{ user_id: string }>(
        `SELECT user_id FROM production_member
         WHERE production_id = $1 AND roles && $2::text[] AND status = 'active'`,
        [t.productionId, node.roleNames ?? []],
      );
      ids = rows.map((r) => r.user_id);
      break;
    }
    case "specific_members": {
      const { rows } = await getPool().query<{ user_id: string }>(
        `SELECT user_id FROM production_member
         WHERE production_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'active'`,
        [t.productionId, node.memberIds ?? []],
      );
      ids = rows.map((r) => r.user_id);
      break;
    }
  }
  return [...new Set(ids)].filter((id) => id !== t.subjectId);
}

/** 模版节点来源 → 阶梯级名（链条目用；project_role/specific_members 无对应级）。 */
function stageOfSource(source: ApprovalAssigneeSource): ApprovalStageName | undefined {
  return source === "project_role" || source === "specific_members" ? undefined : source;
}

// ─── 编译与推进 ───────────────────────────────────────────────────────────────

/** escalation_chain 条目（结构同 lib/db.ts 的 ApprovalChainEntry；JSONB 落库）。 */
type FlowChainEntry = {
  phase: "supervisor" | "resource";
  stage?: ApprovalStageName;
  depth: number;
  canFinalize: boolean;
  approverIds: string[];
  notifiedAt: string;
  /** 模版流扩展字段：时间线（prC）据此显示节点名而非级名。 */
  nodeId: string;
  nodeTitle: string;
};

function chainEntryForNode(node: FlowSnapshotNode, approverIds: string[]): FlowChainEntry {
  return {
    phase: node.assigneeSource === "supervisor" ? "supervisor" : "resource",
    stage: stageOfSource(node.assigneeSource),
    depth: 0,
    // 模版节点恒可完成本节点（收件箱 canFinalize 读链末条；阶梯的 forward-only
    // 是 supervisor 级的持权规则，不适用模版语义）。
    canFinalize: true,
    approverIds,
    notifiedAt: new Date().toISOString(),
    nodeId: node.id,
    nodeTitle: node.title,
  };
}

type WalkResult = {
  snapshot: FlowSnapshot;
  /** null = 所有节点走完，该终局。 */
  active: { node: FlowSnapshotNode; approverIds: string[] } | null;
  chainEntries: FlowChainEntry[];
  notifies: FlowNotifyPlan[];
};

/**
 * 从 cursor 起步进到第一个可等待的节点：cc 到达即投递继续走；空处理人按
 * optional 跳过或兜底 owner；owner 兜底也为空（owner 即申请人）只能跳过——
 * 没有可阻塞的对象，阻塞就是永久卡死。
 */
async function walkToNextActionable(
  snapshot: FlowSnapshot,
  fromCursor: number,
  t: ApprovalTarget,
): Promise<WalkResult> {
  const s: FlowSnapshot = { ...snapshot, nodes: snapshot.nodes.map((n) => ({ ...n })) };
  const chainEntries: FlowChainEntry[] = [];
  const notifies: FlowNotifyPlan[] = [];
  const now = () => new Date().toISOString();

  let cursor = fromCursor;
  while (cursor < s.nodes.length) {
    const node = s.nodes[cursor];
    const resolved = await resolveNodeAssignees(node, t);

    if (node.type === "cc") {
      node.state = "done";
      node.enteredAt = now();
      node.completedAt = node.enteredAt;
      node.deliveredTo = resolved;
      if (resolved.length > 0) {
        notifies.push({ kind: "cc", nodeId: node.id, nodeTitle: node.title, recipientIds: resolved });
      }
      cursor++;
      continue;
    }

    let approverIds = resolved;
    let ownerFallback = false;
    if (approverIds.length === 0) {
      if (node.optional) {
        node.state = "skipped";
        node.skippedReason = "empty_assignees";
        node.enteredAt = now();
        node.completedAt = node.enteredAt;
        cursor++;
        continue;
      }
      const ownerId = await findProductionOwner(t.productionId);
      approverIds = ownerId && ownerId !== t.subjectId ? [ownerId] : [];
      ownerFallback = approverIds.length > 0;
      if (approverIds.length === 0) {
        node.state = "skipped";
        node.skippedReason = "empty_assignees";
        node.enteredAt = now();
        node.completedAt = node.enteredAt;
        cursor++;
        continue;
      }
    }

    node.state = "active";
    node.enteredAt = now();
    node.resolvedApproverIds = approverIds;
    if (ownerFallback) node.ownerFallback = true;
    s.cursor = cursor;
    chainEntries.push(chainEntryForNode(node, approverIds));
    notifies.push({
      kind: "node_pending",
      nodeId: node.id,
      nodeTitle: node.title,
      nodeType: node.type as "approval" | "processing",
      approverIds,
      context: "new",
    });
    return { snapshot: s, active: { node, approverIds }, chainEntries, notifies };
  }

  s.cursor = s.nodes.length;
  return { snapshot: s, active: null, chainEntries, notifies };
}

/** 该项目当前使用中的模版（编译源选择；单数由部分唯一索引保证）。 */
export async function findPublishedTemplate(
  productionId: string,
): Promise<{ id: string; name: string; nodes: ApprovalTemplateNode[] } | null> {
  const { rows } = await getPool().query<{ id: string; name: string; nodes: ApprovalTemplateNode[] }>(
    `SELECT id, name, nodes FROM approval_flow_template
     WHERE production_id = $1 AND status = 'published'`,
    [productionId],
  );
  return rows[0] ?? null;
}

export type PreparedFlow = {
  snapshot: FlowSnapshot;
  templateId: string;
  currentApproverIds: string[];
  chainEntries: FlowChainEntry[];
  notifies: FlowNotifyPlan[];
};

/**
 * 提交时的模版流初始化。返回 null = 不走模版：无已发布模版，或敏感项——
 * 敏感项跳过整条链直达 owner 是治理语义（批F），模版不得弱化它。
 * 全节点都不可等待（全 cc/全跳过）也返回 null：一条提交即完成的"审批流"
 * 等于未经任何人同意就发权限，退回阶梯路径把关。
 */
export async function prepareTemplateFlow(t: ApprovalTarget): Promise<PreparedFlow | null> {
  if (classifyApprovalNode(t.resourceType, t.resourceSub, t.permissionLevel) !== "normal") return null;
  const template = await findPublishedTemplate(t.productionId);
  if (!template) return null;

  const snapshot: FlowSnapshot = {
    v: 1,
    templateId: template.id,
    templateName: template.name,
    cursor: 0,
    nodes: template.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      assigneeSource: n.assigneeSource,
      ...(n.roleNames ? { roleNames: n.roleNames } : {}),
      ...(n.memberIds ? { memberIds: n.memberIds } : {}),
      timeoutHours: n.timeoutHours,
      optional: n.optional,
      state: "pending" as const,
    })),
  };

  const walked = await walkToNextActionable(snapshot, 0, t);
  if (!walked.active) return null;

  return {
    snapshot: walked.snapshot,
    templateId: template.id,
    currentApproverIds: walked.active.approverIds,
    chainEntries: walked.chainEntries,
    notifies: walked.notifies,
  };
}

// ─── 动作 ─────────────────────────────────────────────────────────────────────

function targetOfRow(req: FlowRequestRow): ApprovalTarget {
  return {
    productionId: req.production_id,
    subjectId: req.subject_id,
    resourceType: req.resource_type ?? "",
    resourceId: req.resource_id ?? "*",
    resourceSub: req.resource_sub ?? "*",
    permissionLevel: req.permission_level ?? "",
  };
}

/**
 * 落库一次推进：补旧链末条、追加新链条目、换 current_approver_ids、写新快照。
 * 乐观锁押 status + 旧 cursor —— 同一节点上的并发动作只有一个能成
 * （first-action-wins，与阶梯的 advanceToStage 同纪律）。
 */
async function persistAdvance(
  req: FlowRequestRow,
  prevCursor: number,
  walked: WalkResult,
  markPrev: Record<string, unknown>,
  nextStatus: string,
  nextApproverIds: string[],
): Promise<boolean> {
  const { rows } = await getPool().query<{ id: string }>(
    `UPDATE approval_request
     SET status = $2,
         current_stage = NULL,
         current_stage_depth = 0,
         current_approver_ids = $3::uuid[],
         flow_snapshot = $4::jsonb,
         escalation_chain =
           CASE WHEN jsonb_array_length(escalation_chain) > 0
                THEN jsonb_set(
                       escalation_chain,
                       ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
                       (escalation_chain -> -1) || $5::jsonb)
                ELSE escalation_chain
           END || $6::jsonb
     WHERE id = $1
       AND status IN ('pending_supervisor', 'pending_resource')
       AND (flow_snapshot ->> 'cursor')::int = $7
     RETURNING id`,
    [
      req.id, nextStatus, nextApproverIds,
      JSON.stringify(walked.snapshot),
      JSON.stringify(markPrev),
      JSON.stringify(walked.chainEntries),
      prevCursor,
    ],
  );
  return rows.length > 0;
}

export type FlowAdvanceResult =
  | { outcome: "advanced"; notifies: FlowNotifyPlan[] }
  | { outcome: "complete"; finalSnapshot: FlowSnapshot }
  | { outcome: "conflict" };

/**
 * 批准/完成动作：把当前节点记 done（v1 或签——任一当前处理人动作即完成节点），
 * 步进到下一个可等待节点。走完全部节点 → 返回 complete，由调用方
 * （approveAccessRequest）执行既有终局路径：status=approved + 发行 grant。
 * 终局前快照由调用方随终局 UPDATE 一起落，保持首动作胜出的原子性。
 */
export async function advanceFlowOnApprove(
  req: FlowRequestRow,
  actorId: string,
  comment: string | null,
): Promise<FlowAdvanceResult> {
  const snapshot = parseFlowSnapshot(req.flow_snapshot);
  if (!snapshot) return { outcome: "conflict" };
  const cursor = snapshot.cursor;
  const current = snapshot.nodes[cursor];
  if (!current || current.state !== "active") return { outcome: "conflict" };

  const done: FlowSnapshot = { ...snapshot, nodes: snapshot.nodes.map((n) => ({ ...n })) };
  const doneNode = done.nodes[cursor];
  doneNode.state = "done";
  doneNode.completedAt = new Date().toISOString();
  doneNode.responses = [
    ...(doneNode.responses ?? []),
    {
      userId: actorId,
      action: current.type === "processing" ? "completed" : "approved",
      actedAt: doneNode.completedAt,
      ...(comment ? { comment } : {}),
    },
  ];

  const walked = await walkToNextActionable(done, cursor + 1, targetOfRow(req));
  if (!walked.active) return { outcome: "complete", finalSnapshot: walked.snapshot };

  const markPrev = {
    action: "approved",
    actorId,
    actedAt: doneNode.completedAt,
    ...(comment ? { comment } : {}),
  };
  const moved = await persistAdvance(
    req, cursor, walked, markPrev, "pending_resource", walked.active.approverIds,
  );
  if (!moved) return { outcome: "conflict" };
  return { outcome: "advanced", notifies: walked.notifies };
}

export type FlowForwardResult =
  | { outcome: "forwarded"; notifies: FlowNotifyPlan[] }
  | { outcome: "already_owner" }
  | { outcome: "conflict" };

/**
 * 节点内向上转交（手动/超时共用）：v1 模版节点无内部升级链，转交一律落
 * owner 兜底——节点不换、处理人换成 owner。已在 owner 手上则无处可转。
 */
export async function forwardFlowNodeToOwner(
  req: FlowRequestRow,
  opts: { actorId?: string; reason: "forwarded" | "timeout"; comment?: string | null },
): Promise<FlowForwardResult> {
  const snapshot = parseFlowSnapshot(req.flow_snapshot);
  if (!snapshot) return { outcome: "conflict" };
  const cursor = snapshot.cursor;
  const node = snapshot.nodes[cursor];
  if (!node || node.state !== "active") return { outcome: "conflict" };

  const t = targetOfRow(req);
  const ownerId = await findProductionOwner(t.productionId);
  if (!ownerId || ownerId === t.subjectId) return { outcome: "already_owner" };
  if ((req.current_approver_ids ?? []).includes(ownerId)) return { outcome: "already_owner" };

  const s: FlowSnapshot = { ...snapshot, nodes: snapshot.nodes.map((n) => ({ ...n })) };
  const target = s.nodes[cursor];
  target.resolvedApproverIds = [ownerId];
  target.ownerFallback = true;

  const markPrev = {
    action: "escalated",
    actedAt: new Date().toISOString(),
    escalationReason: opts.reason,
    ...(opts.actorId ? { actorId: opts.actorId } : { bySystem: true }),
    ...(opts.comment ? { comment: opts.comment } : {}),
  };
  const walked: WalkResult = {
    snapshot: s,
    active: { node: target, approverIds: [ownerId] },
    chainEntries: [chainEntryForNode(target, [ownerId])],
    notifies: [{
      kind: "node_pending",
      nodeId: target.id,
      nodeTitle: target.title,
      nodeType: target.type as "approval" | "processing",
      approverIds: [ownerId],
      context: opts.reason === "timeout" ? "timeout" : "forwarded",
      handoffComment: opts.comment ?? null,
    }],
  };
  const moved = await persistAdvance(req, cursor, walked, markPrev, "pending_resource", [ownerId]);
  if (!moved) return { outcome: "conflict" };
  return { outcome: "forwarded", notifies: walked.notifies };
}

export type FlowTimeoutResult =
  | { outcome: "advanced"; notifies: FlowNotifyPlan[] }
  | { outcome: "forwarded"; notifies: FlowNotifyPlan[] }
  | { outcome: "already_owner" }
  | { outcome: "conflict" };

/**
 * 超时处理（cron 调用）。可跳过节点：跳过继续走——但跳过后再无可等待节点时
 * **不许静默终局**（超时自动发权限 = 无人同意的授权），退回 owner 兜底。
 * 不可跳过节点：转交 owner（v1 节点内无升级链，owner 即链尽头）。
 */
export async function timeoutFlowNode(req: FlowRequestRow): Promise<FlowTimeoutResult> {
  const snapshot = parseFlowSnapshot(req.flow_snapshot);
  if (!snapshot) return { outcome: "conflict" };
  const cursor = snapshot.cursor;
  const node = snapshot.nodes[cursor];
  if (!node || node.state !== "active") return { outcome: "conflict" };

  if (!node.optional) return forwardFlowNodeToOwner(req, { reason: "timeout" });

  const s: FlowSnapshot = { ...snapshot, nodes: snapshot.nodes.map((n) => ({ ...n })) };
  const skipped = s.nodes[cursor];
  skipped.state = "skipped";
  skipped.skippedReason = "timeout";
  skipped.completedAt = new Date().toISOString();

  const walked = await walkToNextActionable(s, cursor + 1, targetOfRow(req));
  if (!walked.active) return forwardFlowNodeToOwner(req, { reason: "timeout" });

  const markPrev = {
    action: "escalated",
    actedAt: skipped.completedAt,
    escalationReason: "timeout",
    bySystem: true,
  };
  const moved = await persistAdvance(
    req, cursor, walked, markPrev, "pending_resource", walked.active.approverIds,
  );
  if (!moved) return { outcome: "conflict" };
  return { outcome: "advanced", notifies: walked.notifies };
}

/**
 * 节点超时时限（小时）：节点自带的 timeoutHours 优先，缺省回项目配置/全局默认。
 * cron 的选行 SQL 与此同一口径（lib/db.ts escalateExpiredApprovals）。
 */
export function nodeTimeoutHours(snapshot: FlowSnapshot, configTtlHours: number | null): number {
  const node = snapshot.nodes[snapshot.cursor];
  return node?.timeoutHours ?? configTtlHours ?? DEFAULT_APPROVAL_TTL_HOURS;
}
