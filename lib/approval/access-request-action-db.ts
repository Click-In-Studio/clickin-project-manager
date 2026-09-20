/**
 * 资源访问申请（approval_request）的**状态机与通知**。
 *
 * 提交 / 批准 / 向上转交 / 拒绝 / 撤回 / cron 超时升级——每个动作 = 一条带乐观锁的
 * UPDATE + 给相关人投递通知。「谁来批」全部由 approval-routing.ts 的阶梯或
 * approval-flow-engine.ts 的模版流算出，此处只负责落库、通知、状态推进。
 *
 * 读模型（类型、行映射、people 填充、鉴权、列表 / 预览 / 流程视图）在
 * access-request-db.ts，本文件单向依赖它。
 */
import { getPool } from "../pg";
import { notifyUser, notifyUsers } from "../notify/notify";
import { SERVER_URL } from "../server-url";
import {
  buildApprovalLadder, classifyApprovalNode, DEFAULT_APPROVAL_TTL_HOURS,
  expandLevelRows, nextStage, stageStatus,
  type ApprovalStage, type ApprovalTarget,
} from "./approval-routing";
import { isValidCustomExpiry, isValidTtlInterval } from "./approval-ttl";
import {
  advanceFlowOnApprove, forwardFlowNodeToOwner, prepareTemplateFlow, timeoutFlowNode,
  type FlowNotifyPlan, type FlowSnapshot,
} from "./approval-flow-engine";
import { approvalStageLabel, isApprovalCommentTooLong, normalizeApprovalComment } from "./approval-stages";
import {
  approvalTargetOf, authorizeApprovalAction, currentPositionOf, isPendingStatus,
  loadApproval, rowToApproval, withApprovalPeople,
  type ApprovalChainEntry, type ApprovalRequest, type ApprovalRow,
} from "./access-request-db";

export class ApprovalRequestError extends Error {
  constructor(public reason: "no_entry" | "invalid_ttl" | "no_approver") {
    super(reason);
    this.name = "ApprovalRequestError";
  }
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  cue_list: "Cue表",
  scene:    "章节/段落",
  event:    "事件",
};

const PERMISSION_LEVEL_LABELS: Record<string, string> = {
  view:           "查看",
  mount:          "挂载",
  edit:           "编辑",
  manage:         "管理",
  publish:        "发布",
  edit_published: "修改已发布",
  revoke:         "撤销",
};

/**
 * Returns a human-readable description of a resource for use in notification text.
 * e.g. "「声响」Cue表的编辑权限"
 */
async function describeResource(
  resourceType: string,
  resourceId: string,
  permissionLevel: string,
): Promise<string> {
  const typeLabel  = RESOURCE_TYPE_LABELS[resourceType] ?? resourceType;
  const levelLabel = PERMISSION_LEVEL_LABELS[permissionLevel] ?? permissionLevel;

  // Fetch the specific resource name when a concrete ID is given
  let resourceName: string | null = null;
  if (resourceId !== "*") {
    if (resourceType === "cue_list") {
      const r = await getPool().query<{ name: string }>(
        `SELECT name FROM cue_list WHERE id = $1`,
        [resourceId],
      );
      resourceName = r.rows[0]?.name ?? null;
    } else if (resourceType === "scene") {
      // scene 已是纯身份锚点（marker 化后只剩 id/production_id），名字在
      // scene_version（由 marker 派生）。旧写法查 scene.name/number 必抛 42703。
      const r = await getPool().query<{ name: string }>(
        `SELECT COALESCE(NULLIF(sv.name, ''), '未命名') AS name
         FROM scene s
         JOIN production p ON p.id = s.production_id
         JOIN scene_version sv ON sv.scene_id = s.id AND sv.version_id = p.active_version_id
         WHERE s.id = $1`,
        [resourceId],
      );
      resourceName = r.rows[0]?.name ?? null;
    } else if (resourceType === "event") {
      const r = await getPool().query<{ name: string }>(
        `SELECT COALESCE(name, '') AS name FROM production_event WHERE id = $1`,
        [resourceId],
      );
      resourceName = r.rows[0]?.name || null;
    }
  }

  // 名字解析不出来 ≠ 申请的是全部资源：具体 id 解析失败（资源已删、或跨演出
  // 不可见）时说「所有X」是把申请范围说大了，审批人据此判断就是错的。
  const resourceDesc = resourceName
    ? `「${resourceName}」${typeLabel}`
    : resourceId !== "*" ? `某个${typeLabel}` : `所有${typeLabel}`;
  return `${resourceDesc}的${levelLabel}权限`;
}

function chainEntryFor(stage: ApprovalStage): ApprovalChainEntry {
  return {
    phase: stage.stage === "supervisor" ? "supervisor" : "resource",
    stage: stage.stage,
    depth: stage.depth,
    canFinalize: stage.canFinalize,
    approverIds: stage.approverIds,
    notifiedAt: new Date().toISOString(),
  };
}

/**
 * 给 escalation_chain 末条补字段（批准/拒绝/转发的落点）。
 * 单条 SQL 完成读改写——旧代码是「读出整条链 → JS 改 → 整条写回」，
 * 期间若有别的升级追加了条目就会被覆盖掉。
 */
async function markLastChainEntry(requestId: string, patch: Partial<ApprovalChainEntry>): Promise<void> {
  await getPool().query(
    `UPDATE approval_request
     SET escalation_chain = jsonb_set(
           escalation_chain,
           ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
           (escalation_chain -> -1) || $2::jsonb)
     WHERE id = $1 AND jsonb_array_length(escalation_chain) > 0`,
    [requestId, JSON.stringify(patch)],
  );
}

async function expireRequestNotifications(requestId: string): Promise<void> {
  // 排除抄送：cc 是知会不是待办，没有可失效的动作——每次节点推进都把抄送
  // 记录标成 expired 会让抄送人的收件箱历史显示「已失效」（prB review）。
  await getPool().query(
    `UPDATE user_notification SET expired_at = now()
     WHERE approval_request_id = $1 AND expired_at IS NULL AND acted_at IS NULL
       AND kind <> 'approval_request_cc'`,
    [requestId],
  );
}

/**
 * 自定义有效期的申请，在「提交 → 批准」的等待期里被跨过到期日 = 这条申请已经
 * 没有可发放的东西了。自定义档位存的是**绝对时间**（不像固定档位从批准时起算），
 * 所以审批拖过所选日期是常态，不是边角。
 *
 * 不处理的话它会落到 approve 的 first-action-wins 0 行分支，回一句「已被他人
 * 处理」的假错误，而申请永远停在 pending —— 审批人点多少次都是同一条谎，待办
 * 永远挂在收件箱里。按「被新申请取代」的同一套处理：自动 cancel、过期待办、
 * 链上记明原因，并告诉申请人这条已经作废、需要重提。
 *
 * 返回 true 表示这次调用确实把它终结了（或它已被并发的另一路终结）。
 */
async function cancelIfCustomExpiryPassed(req: ApprovalRow): Promise<boolean> {
  if (!req.requested_expires_at || req.requested_expires_at.getTime() > Date.now()) return false;

  // 到期判定以 DB 的 now() 为准，别用上面那次 JS 比较的结果去写库：
  // JS 侧只是为了不给绝大多数请求平白加一次 UPDATE。
  //
  // 改状态与补链末条必须在**同一条 SQL** 里（和 supersede 同理，AI review #353）：
  // 分两步做的话，进程死在中间会留下一条 status='cancelled' 但链末条没有
  // cancelReason 的申请，时间线只好把它画成「申请已撤回」—— 一条没人撤过的
  // 申请显示成被申请人撤回，正是这个模块要消灭的那类误导。
  //
  // resolved_by 留 NULL：没有人处理这条申请，是它自己作废的。时间线据此把终结
  // 节点画成「系统自动处理」而不是安一个并没做事的操作人。
  const expiredMark: Partial<ApprovalChainEntry> = {
    action: "cancelled",
    actedAt: new Date().toISOString(),
    bySystem: true,
    cancelReason: "expired",
  };
  const res = await getPool().query<{ id: string }>(
    `UPDATE approval_request
     SET status = 'cancelled', resolved_at = now(),
         escalation_chain =
           CASE WHEN jsonb_array_length(escalation_chain) > 0
                THEN jsonb_set(
                       escalation_chain,
                       ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
                       (escalation_chain -> -1) || $2::jsonb)
                ELSE escalation_chain
           END,
         current_stage = NULL, current_approver_ids = '{}'
     WHERE id = $1
       AND status IN ('pending_supervisor', 'pending_resource')
       AND requested_expires_at IS NOT NULL
       AND requested_expires_at <= now()
     RETURNING id`,
    [req.id, JSON.stringify(expiredMark)],
  );
  if (!res.rows[0]) return false;

  await expireRequestNotifications(req.id);

  const desc = await describeResource(req.resource_type ?? "", req.resource_id ?? "*", req.permission_level ?? "");
  await notifyUser({
    userId: req.subject_id,
    productionId: req.production_id,
    kind: "approval_request_result",
    entityType: "approval_request",
    entityId: req.id,
    title: "资源访问申请已过期",
    body: `你申请的${desc}在审批完成前已过所选的到期日期，申请自动结束。如仍需要，请重新提交并选择更晚的日期。`,
    viewHref: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    category: "warning",
    approvalRequestId: req.id,
    buildExternalMessage: async () => ({
      text: `你申请的${desc}已过所选到期日期，需重新提交`,
      title: `资源申请已过期`,
      primaryUrl: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    }),
  });
  return true;
}

/**
 * 把申请推进到指定级：给旧末条补落点、追加新级条目、改写 current_*，
 * 并对「当前级」做乐观锁 —— 手动转交与 cron 超时升级可能撞车，
 * WHERE 里带上原级 → 只有一个能成。
 *
 * 补旧条目与追加新条目必须在同一条 SQL 里：分两步做的话，落败的一方会先把
 * 赢家刚写下的新条目当成"旧末条"改掉。
 */
async function advanceToStage(
  req: ApprovalRow,
  stage: ApprovalStage,
  markPrev: Partial<ApprovalChainEntry>,
): Promise<boolean> {
  const { rows } = await getPool().query<{ id: string }>(
    `UPDATE approval_request
     SET status = $2,
         current_stage = $3,
         current_stage_depth = $4,
         current_approver_ids = $5::uuid[],
         escalation_chain =
           CASE WHEN jsonb_array_length(escalation_chain) > 0
                THEN jsonb_set(
                       escalation_chain,
                       ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
                       (escalation_chain -> -1) || $10::jsonb)
                ELSE escalation_chain
           END || $6::jsonb
     WHERE id = $1
       AND status = $7
       AND current_stage IS NOT DISTINCT FROM $8
       AND current_stage_depth = $9
     RETURNING id`,
    [
      req.id, stageStatus(stage.stage), stage.stage, stage.depth, stage.approverIds,
      JSON.stringify([chainEntryFor(stage)]),
      req.status, req.current_stage, req.current_stage_depth ?? 0,
      JSON.stringify(markPrev),
    ],
  );
  return rows.length > 0;
}

// 级名文案已上移到 lib/approval/approval-stages.ts —— 通知标题与页面时间线共用一份，
// 不然同一级在飞书里叫「资源持有者」、在页面上叫「资源持有人」。

type StageNotifyContext = "new" | "timeout" | "forwarded";

/**
 * 通知某一级的审批人。无权终局的直属上级拿到的是「转发」而非「批准」。
 *
 * handoffComment = 上一级转交时写下的理由。带上它，下一级才知道为什么轮到自己；
 * 不带的话「由上一级转发」就是一句没有信息量的话。
 */
async function notifyStage(
  req: ApprovalRow,
  stage: ApprovalStage,
  context: StageNotifyContext,
  handoffComment?: string | null,
): Promise<void> {
  if (stage.approverIds.length === 0) return;

  const nameRes = await getPool().query<{ name: string }>(
    `SELECT name FROM user_profile WHERE user_id = $1`,
    [req.subject_id],
  );
  const subjectName = nameRes.rows[0]?.name ?? "成员";
  const desc = await describeResource(req.resource_type ?? "", req.resource_id ?? "*", req.permission_level ?? "");
  const suffix = context === "timeout"   ? "（上一级审批超时，已自动升级）"
               : context === "forwarded" ? "（由上一级转发）"
               : "";
  const requestId = req.id;

  const actions = stage.canFinalize
    ? [
        { id: "approve", presentation: "primary_button" as const, label: "批准", effects: [{ type: "approve_access_request" as const, requestId }] },
        { id: "reject",  presentation: "secondary_button" as const, label: "拒绝", effects: [{ type: "reject_access_request" as const, requestId }] },
      ]
    : [
        // #140：上级本人没有这个权限 → 只能向上转发，不能批准
        { id: "escalate", presentation: "primary_button" as const, label: "向上转交", effects: [{ type: "escalate_access_request" as const, requestId }] },
        { id: "reject",   presentation: "secondary_button" as const, label: "拒绝",   effects: [{ type: "reject_access_request" as const, requestId }] },
      ];

  const noteLine = req.note ? `\n\n申请理由：${req.note}` : "";
  const handoffLine = handoffComment ? `\n\n上一级转交说明：${handoffComment}` : "";
  const body = stage.canFinalize
    ? `${subjectName} 申请获得${desc}${suffix}，请审批。${noteLine}${handoffLine}`
    : `${subjectName} 申请获得${desc}${suffix}。你本人尚未持有该权限，只能向上转交给下一级审批人。${noteLine}${handoffLine}`;

  await notifyUsers({
    userIds: stage.approverIds,
    productionId: req.production_id,
    kind: "approval_request_pending",
    entityType: "approval_request",
    entityId: requestId,
    title: `${subjectName} 申请 ${desc}${suffix}`,
    body,
    viewHref: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    category: "action",
    actionRequired: true,
    approvalRequestId: requestId,
    actions,
    buildExternalMessage: async () => ({
      text: `${subjectName} 申请 ${desc}${suffix}，请处理`,
      title: `资源申请待${stage.canFinalize ? "审批" : "转交"}（${approvalStageLabel(stage.stage, stage.depth)}）`,
      primaryUrl: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    }),
  });
}

/**
 * 执行模版流引擎返回的通知计划（分层纪律：引擎只算状态与计划，文案、
 * user_notification 与外部消息投递都在这边——与 notifyStage 同一屋檐）。
 */
async function runFlowNotifies(req: ApprovalRow, notifies: FlowNotifyPlan[]): Promise<void> {
  if (notifies.length === 0) return;
  const nameRes = await getPool().query<{ name: string }>(
    `SELECT name FROM user_profile WHERE user_id = $1`,
    [req.subject_id],
  );
  const subjectName = nameRes.rows[0]?.name ?? "成员";
  const desc = await describeResource(req.resource_type ?? "", req.resource_id ?? "*", req.permission_level ?? "");
  const href = `${SERVER_URL}/production/${req.production_id}/access-requests`;

  for (const plan of notifies) {
    if (plan.kind === "cc") {
      // 抄送：知会不索动作——actionRequired=false，无按钮，不进待办计数
      await notifyUsers({
        userIds: plan.recipientIds,
        productionId: req.production_id,
        kind: "approval_request_cc",
        entityType: "approval_request",
        entityId: req.id,
        title: `[抄送] ${subjectName} 的资源申请到达「${plan.nodeTitle}」`,
        body: `${subjectName} 申请获得${desc}，流程已到达「${plan.nodeTitle}」节点，此消息仅为知会。`,
        viewHref: href,
        category: "info",
        approvalRequestId: req.id,
        buildExternalMessage: async () => ({
          text: `[抄送] ${subjectName} 申请 ${desc}`,
          title: `资源申请抄送（${plan.nodeTitle}）`,
          primaryUrl: href,
        }),
      });
      continue;
    }

    const isProcessing = plan.nodeType === "processing";
    const suffix = plan.context === "timeout"   ? "（上一处理人超时，已自动转交）"
                 : plan.context === "forwarded" ? "（由上一处理人转交）"
                 : "";
    const handoffLine = plan.handoffComment ? `\n\n转交说明：${plan.handoffComment}` : "";
    const noteLine = req.note ? `\n\n申请理由：${req.note}` : "";
    await notifyUsers({
      userIds: plan.approverIds,
      productionId: req.production_id,
      kind: "approval_request_pending",
      entityType: "approval_request",
      entityId: req.id,
      title: `${subjectName} 申请 ${desc}${suffix}`,
      body: isProcessing
        ? `${subjectName} 的${desc}申请已完成审批，进入「${plan.nodeTitle}」节点，请完成实际开通后确认。${noteLine}${handoffLine}`
        : `${subjectName} 申请获得${desc}${suffix}，当前节点「${plan.nodeTitle}」，请审批。${noteLine}${handoffLine}`,
      viewHref: href,
      category: "action",
      actionRequired: true,
      approvalRequestId: req.id,
      actions: [
        {
          id: "approve", presentation: "primary_button" as const,
          label: isProcessing ? "确认完成" : "批准",
          effects: [{ type: "approve_access_request" as const, requestId: req.id }],
        },
        {
          id: "reject", presentation: "secondary_button" as const, label: "拒绝",
          effects: [{ type: "reject_access_request" as const, requestId: req.id }],
        },
      ],
      buildExternalMessage: async () => ({
        text: `${subjectName} 申请 ${desc}${suffix}，请处理`,
        title: `资源申请待${isProcessing ? "开通" : "审批"}（${plan.nodeTitle}）`,
        primaryUrl: href,
      }),
    });
  }
}

export type SubmitAccessRequestParams = {
  type?: "resource_access" | "atomic_permission";
  resourceType: string;
  resourceId?: string;
  resourceSub?: string;
  permissionLevel: string;
  grantType?: "permanent" | "ttl";
  /** Postgres INTERVAL 字面量，且必须来自 TTL_OPTIONS（lib/approval/approval-ttl.ts）。 */
  ttlDuration?: string | null;
  /** 自定义档位的 ISO 绝对到期时间；与 ttlDuration 二选一。 */
  requestedExpiresAt?: string | null;
  note?: string | null;
};

export async function submitAccessRequest(
  productionId: string,
  userId: string,
  params: SubmitAccessRequestParams,
): Promise<ApprovalRequest> {
  const resourceId = params.resourceId ?? "*";
  const resourceSub = params.resourceSub ?? "*";
  const requestType = params.type ?? "resource_access";
  const grantType = params.grantType ?? "permanent";
  // 固定档位与自定义日期二选一。校验放在这里而非只在路由——任何调用方
  // 都必须经过同一道门，避免 ttl 落成 expires_at=NULL 的永久权限。
  //
  // 互斥要按**存在性**判，不能按「哪个校验通过」判：DB 的
  // approval_request_ttl_source_exclusive 卡的就是存在性，两边口径一错，
  // 「合法 ttlDuration + 垃圾 requestedExpiresAt」这种脏输入会一路穿到
  // Postgres，换来一个 500 而不是 400（AI review #353）。
  // `||` 而非 `??`：空串要归一成 NULL，否则 ''::TIMESTAMPTZ 同样是 500。
  const ttlDuration = grantType === "ttl" ? params.ttlDuration || null : null;
  const requestedExpiresAt = grantType === "ttl" ? params.requestedExpiresAt || null : null;
  if (grantType === "ttl") {
    const hasDuration = ttlDuration !== null;
    const hasCustomExpiry = requestedExpiresAt !== null;
    if (hasDuration === hasCustomExpiry) throw new ApprovalRequestError("invalid_ttl");
    if (hasDuration && !isValidTtlInterval(ttlDuration)) throw new ApprovalRequestError("invalid_ttl");
    if (hasCustomExpiry && !isValidCustomExpiry(requestedExpiresAt)) throw new ApprovalRequestError("invalid_ttl");
  }

  // ROOT 节点（批F 三态）owner-only、连审批通道都没有——申请不该被收下
  if (classifyApprovalNode(params.resourceType, resourceSub, params.permissionLevel) === "root") {
    throw new ApprovalRequestError("no_entry");
  }

  const target: ApprovalTarget = {
    productionId, subjectId: userId,
    resourceType: params.resourceType,
    resourceId, resourceSub,
    permissionLevel: params.permissionLevel,
  };

  // 编译源选择（引擎 §3）：有已发布模版且非敏感 → 模版流；否则阶梯流原路。
  // 敏感项直达 owner 是治理语义，prepareTemplateFlow 内部已拒绝接手。
  const flow = await prepareTemplateFlow(target);

  const ladder = flow ? null : await buildApprovalLadder(target);
  const firstStage = ladder?.[0] ?? null;
  if (!flow && !firstStage) throw new ApprovalRequestError("no_approver");

  // 覆盖式申请自动完成（2026-08-16 用户反馈）：同人同目标同级别的旧 pending 申请
  // 被新申请取代（如先申 1 周又改申 30 天）——自动 cancel 并过期其待办通知，
  // 否则旧申请的审批待办永远挂着，审批人收件箱堆积。
  // 与新申请 INSERT 同事务（AI review）：中途失败不能留"旧的已撤、新的没建"半态；
  // IS NOT DISTINCT FROM 兼容存量 NULL resource_id/sub（新写入恒 '*'，老行可能 NULL）
  const supersedeClient = await getPool().connect();
  let request: ApprovalRow;
  try {
    await supersedeClient.query("BEGIN");
    // 链末条补 cancelled/superseded 必须在**同一条 SQL 同一个事务**里：
    // 走 markLastChainEntry（另取连接）会撞上本事务尚未提交的行锁，直接把自己卡死。
    const supersedeMark: Partial<ApprovalChainEntry> = {
      action: "cancelled",
      actedAt: new Date().toISOString(),
      bySystem: true,
      cancelReason: "superseded",
    };
    const superseded = await supersedeClient.query<{ id: string }>(
      `UPDATE approval_request
       SET status = 'cancelled', resolved_at = now(), resolved_by = $2,
           escalation_chain =
             CASE WHEN jsonb_array_length(escalation_chain) > 0
                  THEN jsonb_set(
                         escalation_chain,
                         ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
                         (escalation_chain -> -1) || $8::jsonb)
                  ELSE escalation_chain
             END,
           current_stage = NULL, current_approver_ids = '{}'
       WHERE production_id = $1 AND subject_id = $2 AND type = $3
         AND resource_type = $4
         AND resource_id IS NOT DISTINCT FROM $5
         AND resource_sub IS NOT DISTINCT FROM $6
         AND permission_level = $7
         AND status IN ('pending_supervisor', 'pending_resource')
       RETURNING id`,
      [
        productionId, userId, requestType, params.resourceType, resourceId, resourceSub,
        params.permissionLevel, JSON.stringify(supersedeMark),
      ],
    );
    for (const r of superseded.rows) {
      await supersedeClient.query(
        `UPDATE user_notification SET expired_at = now()
         WHERE approval_request_id = $1 AND expired_at IS NULL AND acted_at IS NULL
           AND kind <> 'approval_request_cc'`,
        [r.id],
      );
    }
    const insertRes = await supersedeClient.query<ApprovalRow>(
      `INSERT INTO approval_request
         (production_id, subject_id, type,
          resource_type, resource_id, resource_sub,
          permission_level, grant_type, ttl_duration, requested_expires_at, note, status,
          current_stage, current_stage_depth, current_approver_ids, escalation_chain,
          flow_snapshot, flow_template_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::INTERVAL,$10::TIMESTAMPTZ,$11,$12,$13,$14,$15::uuid[],$16::jsonb,
               $17::jsonb,$18)
       RETURNING *`,
      flow
        ? [
            productionId, userId, requestType,
            params.resourceType, resourceId, resourceSub,
            params.permissionLevel, grantType, ttlDuration, requestedExpiresAt,
            params.note ?? null,
            // 模版流恒 pending_resource + current_stage NULL（引擎文件头「行形态」）
            "pending_resource", null, 0,
            flow.currentApproverIds,
            JSON.stringify(flow.chainEntries),
            JSON.stringify(flow.snapshot), flow.templateId,
          ]
        : [
            productionId, userId, requestType,
            params.resourceType, resourceId, resourceSub,
            params.permissionLevel, grantType, ttlDuration, requestedExpiresAt,
            params.note ?? null,
            stageStatus(firstStage!.stage),
            firstStage!.stage, firstStage!.depth, firstStage!.approverIds,
            JSON.stringify([chainEntryFor(firstStage!)]),
            null, null,
          ],
    );
    request = insertRes.rows[0];
    await supersedeClient.query("COMMIT");
  } catch (e) {
    await supersedeClient.query("ROLLBACK");
    throw e;
  } finally {
    supersedeClient.release();
  }

  if (flow) await runFlowNotifies(request, flow.notifies);
  else await notifyStage(request, firstStage!, "new");
  return rowToApproval(request);
}

export async function approveAccessRequest(
  requestId: string,
  actorId: string,
  rawComment?: string | null,
): Promise<
  | { ok: true; request: ApprovalRequest }
  | { ok: false; reason: "not_found" | "conflict" | "unauthorized" | "forward_only" | "expired" | "comment_too_long" }
> {
  const comment = normalizeApprovalComment(rawComment);
  if (isApprovalCommentTooLong(comment)) return { ok: false, reason: "comment_too_long" };

  const req = await loadApproval(requestId);
  if (!req) return { ok: false, reason: "not_found" };
  if (!isPendingStatus(req.status)) return { ok: false, reason: "conflict" };

  const auth = await authorizeApprovalAction(req, actorId);
  if (!auth.authorized) return { ok: false, reason: "unauthorized" };
  // 自定义到期日已被跨过：批下去只会发一条出生即失效的授权。放在鉴权之后、
  // forward_only 之前——本级处理不了的人也该看到「这条已经过期」而不是「去转交」。
  if (await cancelIfCustomExpiryPassed(req)) return { ok: false, reason: "expired" };
  // 直属上级本人没有该权限 → 只能转发（#140；模版流 current_stage 恒 NULL，
  // 不触发该规则——模版里的直属上级节点语义是「完成本节点推进下一节点」）
  if (!auth.canFinalize) return { ok: false, reason: "forward_only" };

  // 模版流（prB）：先完成当前节点。还有后续节点 → 推进并返回，**不终局**；
  // 全部走完 → 带着终态快照落进下面的终局 UPDATE（原子）。
  let finalFlowSnapshot: FlowSnapshot | null = null;
  let flowPrevRev: number | null = null;
  if (req.flow_snapshot) {
    const advanced = await advanceFlowOnApprove(req, actorId, comment);
    if (advanced.outcome === "conflict") return { ok: false, reason: "conflict" };
    if (advanced.outcome === "advanced") {
      await expireRequestNotifications(requestId);
      const freshRow = await loadApproval(requestId);
      if (freshRow) await runFlowNotifies(freshRow, advanced.notifies);
      return { ok: true, request: await withApprovalPeople(rowToApproval(freshRow ?? req)) };
    }
    finalFlowSnapshot = advanced.finalSnapshot;
    flowPrevRev = advanced.prevRev;
  }

  // first-action-wins：状态与所在级都要没被别人动过。模版流的所在级恒 NULL，
  // 改押快照 rev（$6）——不押的话同一瞬间的节点内转交会被终局静默覆盖。
  // 固定档位从批准时开始计时；自定义日期保持申请人选定的绝对时间。
  const updateRes = await getPool().query<{ id: string }>(
    `UPDATE approval_request
     SET status = 'approved',
         resolved_at = now(),
         resolved_by = $2,
         granted_at = now(),
         current_stage = NULL,
         current_approver_ids = '{}',
         flow_snapshot = COALESCE($5::jsonb, flow_snapshot),
         expires_at = CASE WHEN grant_type = 'ttl'
                            THEN COALESCE(requested_expires_at, now() + ttl_duration)
                            ELSE NULL END
     WHERE id = $1 AND status = $3
       AND current_stage IS NOT DISTINCT FROM $4
       AND ($6::int IS NULL OR COALESCE((flow_snapshot ->> 'rev')::int, 0) = $6)
       AND (requested_expires_at IS NULL OR requested_expires_at > now())
     RETURNING id`,
    [requestId, actorId, req.status, req.current_stage,
     finalFlowSnapshot ? JSON.stringify(finalFlowSnapshot) : null,
     flowPrevRev],
  );
  if (!updateRes.rows[0]) return { ok: false, reason: "conflict" };

  await markLastChainEntry(requestId, {
    action: "approved", actorId, actedAt: new Date().toISOString(),
    ...(comment ? { comment } : {}),
  });

  const fresh = await loadApproval(requestId);

  // 终局（批G G-2）：atomic_permission 类型申请已随原子键退役（表已 DROP）——
  // 历史 pending 申请（若有）按无效处理，不再发行
  if (req.type === "atomic_permission") {
    // 原子键机制已退役；生成端已节点化（403 redirect+modal），此处仅防历史 pending。
    console.warn(`[approval] 跳过旧格式 atomic_permission 申请 ${requestId}（不发行）`);
  } else {
    // 批A：REST 化域（cue_list）的伪级别申请在发行时展开为动词行集；
    // 未迁移域仍写单行。蕴含由授权时发多行表达（总表 §0）。
    // 展开表与「上级是否已持有该权限」的判定共用 expandLevelRows，两侧不会漂移。
    const rows = expandLevelRows(req.resource_type ?? "", req.resource_sub ?? "*", req.permission_level ?? "");
    for (const [sub, verb] of rows) {
      await getPool().query(
        `INSERT INTO production_member_grant
           (production_id, user_id, resource_type, resource_id, resource_sub,
            permission_level, grant_source, confirmed_by, approval_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'approval',$7,$8,$9)
         ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
           WHERE is_revoked = false
         DO NOTHING`,
        [
          req.production_id,
          req.subject_id,
          req.resource_type,
          req.resource_id ?? "*",
          sub,
          verb,
          actorId,
          requestId,
          fresh?.expires_at ?? null,
        ],
      );
    }
  }

  await expireRequestNotifications(requestId);

  const approvedDesc = await describeResource(req.resource_type ?? "", req.resource_id ?? "*", req.permission_level ?? "");
  await notifyUser({
    userId: req.subject_id,
    productionId: req.production_id,
    kind: "approval_request_result",
    entityType: "approval_request",
    entityId: requestId,
    title: "资源访问申请已批准",
    body: `你申请的${approvedDesc}已获批准。${comment ? `\n\n审批意见：${comment}` : ""}`,
    viewHref: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    category: "info",
    approvalRequestId: requestId,
    buildExternalMessage: async () => ({
      text: `你申请的${approvedDesc}已获批准`,
      title: `资源申请已批准`,
      primaryUrl: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    }),
  });

  const finalRow = fresh ?? (await loadApproval(requestId))!;
  return { ok: true, request: await withApprovalPeople(rowToApproval(finalRow)) };
}

/**
 * 向上转发（#140）：当前级处理不了 —— 直属上级没有该权限，或部门负责人认为
 * 该由上级定 —— 就把申请推到阶梯的下一级。转发不是拒绝，链路完整记在
 * escalation_chain 里。
 */
export async function escalateAccessRequest(
  requestId: string,
  actorId: string,
  rawComment?: string | null,
): Promise<
  | { ok: true; request: ApprovalRequest }
  | { ok: false; reason: "not_found" | "conflict" | "unauthorized" | "no_next_stage" | "expired" | "comment_too_long" }
> {
  const comment = normalizeApprovalComment(rawComment);
  if (isApprovalCommentTooLong(comment)) return { ok: false, reason: "comment_too_long" };

  const req = await loadApproval(requestId);
  if (!req) return { ok: false, reason: "not_found" };
  if (!isPendingStatus(req.status)) return { ok: false, reason: "conflict" };

  const auth = await authorizeApprovalAction(req, actorId);
  if (!auth.authorized) return { ok: false, reason: "unauthorized" };
  // 往上转交一条已经作废的申请，只是把它挪到下一位审批人的收件箱里继续烂着
  if (await cancelIfCustomExpiryPassed(req)) return { ok: false, reason: "expired" };

  // 模版流（prB）：转交是节点内事件——处理人换成 owner 兜底，节点不换。
  if (req.flow_snapshot) {
    const fwd = await forwardFlowNodeToOwner(req, { actorId, reason: "forwarded", comment });
    if (fwd.outcome === "already_owner") return { ok: false, reason: "no_next_stage" };
    if (fwd.outcome === "conflict") return { ok: false, reason: "conflict" };
    await expireRequestNotifications(requestId);
    const freshRow = await loadApproval(requestId);
    if (freshRow) await runFlowNotifies(freshRow, fwd.notifies);
    return { ok: true, request: await withApprovalPeople(rowToApproval(freshRow ?? req)) };
  }

  const ladder = await buildApprovalLadder(approvalTargetOf(req));
  const next = nextStage(ladder, currentPositionOf(req));
  if (!next) return { ok: false, reason: "no_next_stage" };

  const moved = await advanceToStage(req, next, {
    action: "escalated", actorId, actedAt: new Date().toISOString(), escalationReason: "forwarded",
    ...(comment ? { comment } : {}),
  });
  if (!moved) return { ok: false, reason: "conflict" };

  await expireRequestNotifications(requestId);
  const fresh = await loadApproval(requestId);
  if (fresh) await notifyStage(fresh, next, "forwarded", comment);

  return { ok: true, request: await withApprovalPeople(rowToApproval(fresh ?? req)) };
}

export async function rejectAccessRequest(
  requestId: string,
  actorId: string,
  rawComment?: string | null,
): Promise<
  | { ok: true; request: ApprovalRequest }
  | { ok: false; reason: "not_found" | "conflict" | "unauthorized" | "comment_too_long" }
> {
  const comment = normalizeApprovalComment(rawComment);
  if (isApprovalCommentTooLong(comment)) return { ok: false, reason: "comment_too_long" };

  const req = await loadApproval(requestId);
  if (!req) return { ok: false, reason: "not_found" };
  if (!isPendingStatus(req.status)) return { ok: false, reason: "conflict" };

  const auth = await authorizeApprovalAction(req, actorId);
  if (!auth.authorized) return { ok: false, reason: "unauthorized" };

  const updateRes = await getPool().query<{ id: string }>(
    `UPDATE approval_request
     SET status = 'rejected', resolved_at = now(), resolved_by = $2,
         current_stage = NULL, current_approver_ids = '{}'
     WHERE id = $1 AND status = $3
     RETURNING id`,
    [requestId, actorId, req.status],
  );
  if (!updateRes.rows[0]) return { ok: false, reason: "conflict" };

  await markLastChainEntry(requestId, {
    action: "rejected", actorId, actedAt: new Date().toISOString(),
    ...(comment ? { comment } : {}),
  });
  await expireRequestNotifications(requestId);

  const rejectedDesc = await describeResource(req.resource_type ?? "", req.resource_id ?? "*", req.permission_level ?? "");
  await notifyUser({
    userId: req.subject_id,
    productionId: req.production_id,
    kind: "approval_request_result",
    entityType: "approval_request",
    entityId: requestId,
    title: "资源访问申请被拒绝",
    body: `你申请的${rejectedDesc}未获批准。${comment ? `\n\n拒绝理由：${comment}` : ""}`,
    viewHref: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    category: "warning",
    approvalRequestId: requestId,
    buildExternalMessage: async () => ({
      text: `你申请的${rejectedDesc}未获批准`,
      title: `资源申请被拒绝`,
      primaryUrl: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    }),
  });

  const finalRow = await loadApproval(requestId);
  return { ok: true, request: await withApprovalPeople(rowToApproval(finalRow ?? req)) };
}

/**
 * 申请人撤回自己的申请。
 *
 * resolved_by 必须写：撤回也是「谁在什么时候结束了这条申请」，不写的话时间线上
 * 的终结节点没有人，看着像系统自己结的。链末条同时补 action='cancelled' ——
 * 那一级是**没处理**，不是还在等；不补的话前端只能看到一个没有动作的末条，
 * 只好按「等待中」画成灰点，读起来像申请还挂在那些人手上。
 */
export async function cancelAccessRequest(
  requestId: string,
  userId: string,
  rawComment?: string | null,
): Promise<
  | { ok: true; request: ApprovalRequest }
  | { ok: false; reason: "not_found" | "conflict" | "comment_too_long" }
> {
  const comment = normalizeApprovalComment(rawComment);
  if (isApprovalCommentTooLong(comment)) return { ok: false, reason: "comment_too_long" };

  const res = await getPool().query<{ id: string }>(
    `UPDATE approval_request
     SET status = 'cancelled', resolved_at = now(), resolved_by = $2,
         current_stage = NULL, current_approver_ids = '{}'
     WHERE id = $1
       AND subject_id = $2
       AND status IN ('pending_supervisor', 'pending_resource')
     RETURNING id`,
    [requestId, userId],
  );
  if (!res.rows[0]) {
    const exists = await getPool().query(`SELECT 1 FROM approval_request WHERE id = $1`, [requestId]);
    return exists.rows[0] ? { ok: false, reason: "conflict" } : { ok: false, reason: "not_found" };
  }

  await markLastChainEntry(requestId, {
    action: "cancelled", actorId: userId, actedAt: new Date().toISOString(),
    cancelReason: "by_subject",
    ...(comment ? { comment } : {}),
  });
  await expireRequestNotifications(requestId);

  const finalRow = await loadApproval(requestId);
  return { ok: true, request: await withApprovalPeople(rowToApproval(finalRow!)) };
}

/** Called by the internal cron endpoint — 当前级超时未响应即升级到阶梯下一级。 */
export async function escalateExpiredApprovals(): Promise<{ escalated: number }> {
  // 计时起点是「当前级被通知的时刻」（链末条 notifiedAt），不是申请创建时刻——
  // 否则五级阶梯会在同一个 TTL 里被连着跳完。
  //
  // LEFT JOIN + COALESCE 而非 INNER JOIN：production_approval_config 是 Phase 3
  // 才加的表，建表 SQL 没有回填，早于它的演出一行都没有。INNER JOIN 会让这些
  // 演出的申请**永远**匹配不上、一次也升不了级（线上 8 个演出全部缺行，整条
  // 升级链自 Phase 7 起就是死的）。缺配置=按列默认值计时，不是"不升级"。

  // 模版流（prB）的超时口径：节点自带 timeoutHours 优先，缺省回项目配置。
  // 选行 SQL 与 nodeTimeoutHours() 同一优先级序——两处漂移会让「4h 节点」
  // 要等满项目的 24h 才被选中。
  const { rows } = await getPool().query<ApprovalRow>(
    `SELECT ar.* FROM approval_request ar
     LEFT JOIN production_approval_config pac ON pac.production_id = ar.production_id
     WHERE ar.status IN ('pending_supervisor', 'pending_resource')
       AND COALESCE((ar.escalation_chain -> -1 ->> 'notifiedAt')::timestamptz, ar.created_at)
           < now() - (COALESCE(
               (ar.flow_snapshot -> 'nodes' -> ((ar.flow_snapshot ->> 'cursor')::int) ->> 'timeoutHours')::numeric,
               pac.ttl_hours, $1) || ' hours')::INTERVAL`,
    [DEFAULT_APPROVAL_TTL_HOURS],
  );

  let escalated = 0;
  for (const row of rows) {
    // 模版流：超时是节点内事件（可跳过节点跳过继续；否则转交 owner 兜底）
    if (row.flow_snapshot) {
      const timedOut = await timeoutFlowNode(row);
      if (timedOut.outcome !== "advanced" && timedOut.outcome !== "forwarded") continue;
      escalated++;
      await expireRequestNotifications(row.id);
      const freshRow = await loadApproval(row.id);
      if (freshRow) await runFlowNotifies(freshRow, timedOut.notifies);
      continue;
    }

    const ladder = await buildApprovalLadder(approvalTargetOf(row));
    const next = nextStage(ladder, currentPositionOf(row));
    if (!next) continue;  // 已在链顶（owner），只等人处理，不再升级

    // bySystem：超时升级没有操作人。少了这面旗，消费方只能看到一条有 action
    // 却没有 actorId 的条目，无法区分「系统自动升级」与「数据缺了操作人」。
    const moved = await advanceToStage(row, next, {
      action: "escalated", actedAt: new Date().toISOString(),
      escalationReason: "timeout", bySystem: true,
    });
    if (!moved) continue;
    escalated++;

    await expireRequestNotifications(row.id);
    const fresh = await loadApproval(row.id);
    if (fresh) await notifyStage(fresh, next, "timeout");
  }

  return { escalated };
}
