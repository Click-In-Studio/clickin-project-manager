/**
 * 成员状态的纯类型与文案（#141）。
 *
 * 单独一个无依赖模块，是为了客户端组件能直接引用：lib/member-status.ts 连着 pg，
 * 进不了浏览器包。此前六个组件各自抄了一份 `"active" | "suspended"`，新增第三态
 * 时它们不会报错、只会静默把 exited 当成「在职」显示——那正是这次要修的旧病。
 */

export const MEMBER_STATUSES = ["active", "suspended", "exited"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** 非 active 时的成因：self=成员自助退出，admin=人事停用。 */
export type MemberStatusSource = "self" | "admin";

export const MEMBER_STATUS_LABEL: Record<MemberStatus, string> = {
  active: "在职",
  suspended: "已停用",
  exited: "已离组",
};

/** 停用的两种成因文案不同：自助退出是「他走了」，人事停用是「他被停了」。 */
export function memberStatusLabel(
  status: MemberStatus,
  source: MemberStatusSource | null,
): string {
  if (status === "suspended" && source === "self") return "已退出";
  return MEMBER_STATUS_LABEL[status];
}

/** 名册里是否按「不在职」渲染（灰字 + 删除线）。 */
export function isInactiveMember(status: MemberStatus): boolean {
  return status !== "active";
}
