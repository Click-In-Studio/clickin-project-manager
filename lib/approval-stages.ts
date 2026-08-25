/**
 * 审批阶梯的名字、顺序、展示文案与动作词 —— **前后端共用的唯一来源**。
 *
 * 为什么单开一个模块：这些常量原本躺在 lib/db.ts（通知标题用）与
 * lib/approval-routing.ts（阶梯序用），两个文件都 import pg，client component
 * 引一下就把数据库驱动拖进浏览器包。结果是前端只能自己抄一份阶梯词表，抄完就跟
 * 飞书通知正文漂了——同一级在通知里叫「资源持有者」，在页面上叫「资源持有人」。
 *
 * 此模块**不得** import 任何带 pg / node 依赖的东西：它要能被 "use client" 组件直接引。
 */

/** 审批阶梯级名（#140）。语义与顺序见 lib/approval-routing.ts 顶部注释。 */
export type ApprovalStageName =
  | "supervisor"    // 直属上级链
  | "holder"        // 资源持有者（grants@edit）
  | "dept_poc"      // 共管部门 POC / 个人负责人
  | "ancestor_poc"  // 父部门 POC（逐级向上）
  | "producer"      // 制作人
  | "owner";        // Production Owner

/** 阶梯顺序：升级只能沿此序前进，永不回退。 */
export const STAGE_ORDER: readonly ApprovalStageName[] = [
  "supervisor", "holder", "dept_poc", "ancestor_poc", "producer", "owner",
];

/** 各级的展示名。通知标题与页面时间线共用同一份，改这里两边一起变。 */
export const APPROVAL_STAGE_LABELS: Record<ApprovalStageName, string> = {
  supervisor:   "直属上级",
  holder:       "资源持有者",
  dept_poc:     "共管部门负责人",
  ancestor_poc: "上级部门负责人",
  producer:     "制作人",
  owner:        "演出所有者",
};

/**
 * 同一 stage 内会有多层的两级：上级链逐跳向上、祖先部门逐层向上。
 * 其余级恒 depth=0，带上「第 N 级」只会让人以为还有别的层。
 */
const STAGE_HAS_DEPTH: ReadonlySet<ApprovalStageName> = new Set<ApprovalStageName>([
  "supervisor", "ancestor_poc",
]);

/** 带层深的展示名：`直属上级 · 第 2 级`。depth 从 0 起，展示时 +1。 */
export function approvalStageLabel(stage: ApprovalStageName, depth?: number): string {
  const base = APPROVAL_STAGE_LABELS[stage] ?? stage;
  if (typeof depth === "number" && depth > 0 && STAGE_HAS_DEPTH.has(stage)) {
    return `${base} · 第 ${depth + 1} 级`;
  }
  return base;
}

/** 链条目上记录的动作。cancelled = 该级还没处理，申请就被撤回/顶掉了。 */
export type ApprovalAction = "approved" | "rejected" | "escalated" | "cancelled";

export const APPROVAL_ACTION_LABELS: Record<ApprovalAction, string> = {
  approved:  "已批准",
  rejected:  "已拒绝",
  escalated: "已转交",
  cancelled: "未处理",
};

/**
 * 治理域三态（批F）。root 连审批通道都没有，sensitive 跳过整条链直达 owner——
 * 预览接口要把这两种情况说清楚，否则申请人填完表提交才被 403 拦下。
 */
export type ApprovalNodeClass = "root" | "sensitive" | "normal";

export const APPROVAL_NODE_CLASS_HINTS: Record<ApprovalNodeClass, string | null> = {
  root:      "该权限仅演出所有者可用，没有审批通道，提交也不会受理。",
  sensitive: "该权限属敏感项，跳过常规阶梯直接由演出所有者审批。",
  normal:    null,
};

/** 审批意见/理由的长度上限。前端输入框与后端校验共用，两边不会各写各的。 */
export const MAX_APPROVAL_COMMENT_LENGTH = 500;

/**
 * 归一化审批意见：去空白，空串按「没写」处理。
 * **不截断**——超长在路由层报 400，静默截半句会让审计链留下一条断头的理由。
 */
export function normalizeApprovalComment(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isApprovalCommentTooLong(comment: string | null): boolean {
  return comment !== null && comment.length > MAX_APPROVAL_COMMENT_LENGTH;
}
