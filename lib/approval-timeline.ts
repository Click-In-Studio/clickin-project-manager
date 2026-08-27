/**
 * 审批申请 → 时间线节点。**纯函数，无 IO**，好让这里的降级分支能被单测钉住。
 *
 * 为什么单开一个模块而不是写在组件里：时间线上最容易错的恰恰是那些平时看不见的
 * 分支——超时自动升级、申请被新申请顶掉、存量无链记录。这些状态在页面上极难手工
 * 复现（要等 24 小时、要造存量行），埋在 TSX 里就等于没人验证过。抽出来之后
 * tests/approval-timeline.test.ts 可以直接喂构造好的申请对象。
 *
 * 此模块只做 type-only 的 lib/db 引用（编译期擦除），不碰 pg，client component 可直接引。
 */

import type { ApprovalChainEntry, ApprovalRequest } from "./db";
import { APPROVAL_ACTION_LABELS, approvalStageLabel } from "./approval-stages";

export type TimelineNodeKind = "发起" | "审批" | "发放" | "结束";

/**
 * 没有「等待中」这个状态是有意的：链里只有已经到达过的级（见 entryState 注释），
 * 未来的级不在这份数据里。硬造一个 waiting 只会让「没处理」被误读成「还在等」。
 */
export type TimelineNodeState =
  | "complete"    // 已完成（绿）
  | "current"     // 当前节点（高亮）
  | "rejected"    // 被拒（红）
  | "terminated"; // 没处理就终止了：撤回 / 被新申请顶掉 / 漏补落点（灰）

export type TimelineNode = {
  key: string;
  kind: TimelineNodeKind;
  title: string;
  /** 该节点相关的人（候选审批人 / 申请人 / 终结者）。 */
  people: string[];
  /** ISO 时间串，由渲染侧决定怎么格式化。 */
  time: string;
  state: TimelineNodeState;
  /** 「已批准」「未处理」等动作词，来自 APPROVAL_ACTION_LABELS。 */
  actionLabel?: string;
  /** 动作的操作人。系统动作没有（见 bySystem）。 */
  actorId?: string;
  /** 该动作由系统发起，没有操作人。 */
  bySystem?: boolean;
  /** 为什么发生：超时自动升级 / 审批人转交 / 被新申请取代。 */
  reason?: string;
  /** 审批人写下的意见。 */
  comment?: string;
  /**
   * 该级有多个候选审批人。后端语义是**或签**——任一人处理即完成该级
   * （收件箱与鉴权都只读 current_approver_ids，谁点谁算）。并排展示多人而不说
   * 明这点，会被读成需要全员批准。
   */
  anyOneOf?: boolean;
  /** 发放节点的到期时间：null = 长期有效。 */
  expiresAt?: string | null;
};

/** 链末条：当前级（pending 时）或最后发生动作的那一级。 */
function lastEntry(chain: ApprovalChainEntry[]): ApprovalChainEntry | undefined {
  return chain[chain.length - 1];
}

function isPendingStatus(status: ApprovalRequest["status"]): boolean {
  return status === "pending_supervisor" || status === "pending_resource";
}

/**
 * 链为空但仍在审批中的申请（理论上不该有，存量兜底）：用 current_* 合成一条，
 * 好让「当前卡在谁那儿」至少能显示出来。
 */
function effectiveChain(req: ApprovalRequest): ApprovalChainEntry[] {
  if (req.escalationChain.length > 0) return req.escalationChain;
  if (!req.currentStage) return [];
  return [{
    phase: req.currentStage === "supervisor" ? "supervisor" : "resource",
    stage: req.currentStage,
    approverIds: req.currentApproverIds,
    notifiedAt: req.createdAt,
  }];
}

function stageTitle(entry: ApprovalChainEntry): string {
  // 存量条目没有 stage，只有旧的两段式 phase。
  // 不做 as ApprovalStageName 强转：条目来自 JSONB，类型只是声明不是保证，
  // 强转会把「将来后端加了新级、前端还没跟上」这种情况静默掉。
  // approvalStageLabel 对认不出的级名回退成原字符串——显示得出，也看得出不对劲。
  if (entry.stage) return approvalStageLabel(entry.stage, entry.depth);
  return entry.phase === "supervisor" ? "直属上级" : "资源负责人";
}

/**
 * 链条目 → 节点状态。
 *
 * **关键前提：链里只有「已经到达过」的级。** 后端每次升级才追加一条
 * （submitAccessRequest 插首级，advanceToStage 追加下一级），未来的级根本不在链上。
 * 所以这里永远不会出现「尚未到达」的节点——那种预测要走 preview 接口，是另一份数据。
 *
 * 由此，没有 action 的条目只有两种：
 *   - 待审批申请的**末条** = 当前节点
 *   - 其余 = 异常（升级时漏补落点 / 存量数据）。按「未处理」画，
 *     **不能画成「等待中」**——那读起来像申请还挂在这些人手上，
 *     正是这个模块要消灭的那类误导。
 */
function entryState(
  entry: ApprovalChainEntry,
  isLast: boolean,
  pending: boolean,
): TimelineNodeState {
  if (entry.action === "rejected") return "rejected";
  // cancelled ≠ 完成：这一级根本没处理，申请就被撤回或顶掉了
  if (entry.action === "cancelled") return "terminated";
  if (entry.action) return "complete";
  if (pending && isLast) return "current";
  return "terminated";
}

function entryReason(entry: ApprovalChainEntry): string | undefined {
  if (entry.escalationReason === "timeout") return "无人处理，超时自动升级";
  if (entry.escalationReason === "forwarded") return "审批人向上转交";
  if (entry.cancelReason === "superseded") return "被同目标的新申请取代";
  if (entry.cancelReason === "by_subject") return "申请人撤回";
  if (entry.cancelReason === "expired") return "审批完成前已过所选到期日期";
  return undefined;
}

function terminalNode(req: ApprovalRequest, chain: ApprovalChainEntry[]): TimelineNode | null {
  const last = lastEntry(chain);
  const time = req.resolvedAt ?? req.createdAt;
  const people = req.resolvedBy ? [req.resolvedBy] : [];

  if (req.status === "approved") {
    return { key: "terminal", kind: "结束", title: "流程完成", people, time, state: "complete" };
  }
  if (req.status === "rejected") {
    return { key: "terminal", kind: "结束", title: "流程已拒绝", people, time, state: "rejected" };
  }
  if (req.status === "cancelled") {
    // 「我那条申请怎么自己没了」——被新申请顶掉是最需要说清楚的一种终结
    // 「我那条申请怎么自己没了」有两种：被新申请顶掉，和自定义有效期在审批
    // 完成前就过了。两种都不是人操作的，终结节点不能安一个操作人。
    const superseded = last?.cancelReason === "superseded";
    const expired = last?.cancelReason === "expired";
    return {
      key: "terminal",
      kind: "结束",
      title: superseded ? "已被新申请取代" : expired ? "已过所选到期日期" : "申请已撤回",
      people: superseded || expired ? [] : people,
      time,
      state: "terminated",
      reason: superseded
        ? "你为同一目标提交了新申请，这条自动结束"
        : expired
          ? "审批完成前已过你选定的到期日期，这条自动结束；如仍需要请重新提交"
          : undefined,
    };
  }
  return null;
}

/**
 * 权限发放节点。`grantedAt` / `expiresAt` 一直都在 DTO 里——把它画出来，
 * 「审批通过」与「权限到手」才是两件事，否则「已批准」看起来就等于办结了。
 */
function grantNode(req: ApprovalRequest): TimelineNode | null {
  if (req.status !== "approved" || !req.grantedAt) return null;
  return {
    key: "granted",
    kind: "发放",
    title: "权限已发放",
    people: [],
    time: req.grantedAt,
    state: "complete",
    expiresAt: req.expiresAt,
  };
}

export function buildApprovalTimeline(req: ApprovalRequest): TimelineNode[] {
  const chain = effectiveChain(req);
  const pending = isPendingStatus(req.status);

  const nodes: TimelineNode[] = [{
    key: "initiated",
    kind: "发起",
    title: "提交申请",
    people: [req.subjectId],
    time: req.createdAt,
    state: "complete",
    comment: req.note ?? undefined,
  }];

  chain.forEach((entry, index) => {
    const approverIds = entry.approverIds ?? [];
    nodes.push({
      key: `approval-${index}`,
      kind: "审批",
      title: stageTitle(entry),
      people: approverIds,
      time: entry.actedAt ?? entry.notifiedAt,
      state: entryState(entry, index === chain.length - 1, pending),
      actionLabel: entry.action ? APPROVAL_ACTION_LABELS[entry.action] : undefined,
      actorId: entry.actorId,
      bySystem: entry.bySystem,
      reason: entryReason(entry),
      comment: entry.comment,
      anyOneOf: approverIds.length > 1,
    });
  });

  const granted = grantNode(req);
  if (granted) nodes.push(granted);

  const terminal = terminalNode(req, chain);
  if (terminal) nodes.push(terminal);

  return nodes;
}
