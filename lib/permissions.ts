// ─── 权限上下文（终局形态，批G G-2）────────────────────────────────────────────
//
// 原子权限机制（Permission type / hasPermission / canAccess / activeGrants）已全部
// 退役——168 键六批迁移完毕（见 lib/permission-migration-ledger.ts RETIRED 清单）。
// 判定统一走树模型：
//   行判定  = hasGrant / hasEffectiveGrant（lib/grant-check.ts，production_member_grant 表）
//   六步链  = canAccessNode（lib/grant-template.ts，区间三表 + SENSITIVE 三态）
//   区间源  = production_role_permission / production_dept_permission /
//             production_member_permission（node: 节点串；type/verb 通配见 RESERVED_TYPES）

export type PermissionContext = {
  userId: string;
  isAdmin: boolean;
  isOwner: boolean;
  /** role 区间节点串集合（production_role_permission 表读）；null = 非成员。
   *  同时承担成员身份判定（=== null）与管理面资格判定。 */
  memberPermissions: Set<string> | null;
  /** 历史字段（个人区间已在 production_member_permission 表，经六步链消费）——恒空。 */
  overrides: Map<string, boolean>;
  deptIds: string[];
  pocDeptIds: string[];
  /** 历史字段（dept 区间已在 production_dept_permission 表）——恒空。 */
  deptFreeApprovalZone: Set<string>;
  /** 历史字段（行已在 production_member_grant 表）——恒空。 */
  activeGrants: Set<string>;
};

// ─── 管理面资格（节点键前缀判定）──────────────────────────────────────────────
// 治理域任意区间键（或全通配）在 role 区间内 → 可进入管理面板。
// 用区间资格而非活跃行：制作人未自确认时也能进面板并在面板内激活（原 admin-guard 语义）。

export const ADMIN_PANEL_NODE_PREFIXES: readonly string[] = [
  "node:member/", "node:role/", "node:org_dept/",
  "node:milestone/", "node:announcement/", "node:*",
];

export function hasAdminPanelEligibility(memberPermissions: Set<string> | null): boolean {
  if (memberPermissions === null) return false;
  for (const key of memberPermissions) {
    if (ADMIN_PANEL_NODE_PREFIXES.some((p) => key.startsWith(p))) return true;
  }
  return false;
}

// ─── 角色名单（结构性数据：production 创建时的初始角色行；权限内容在 grant_template 表）──

export const ROLE_NAMES: readonly string[] = [
  "制作人", "编剧", "戏剧构作", "导演", "副导演", "音乐导演", "作曲", "编曲",
  "舞美设计", "灯光设计", "多媒体设计", "服化设计", "音响设计", "音响执行",
  "灯光编程", "技术导演", "执行", "舞台监督", "新媒体", "侧写", "演员", "群演",
  "乐手", "肢体指导", "编舞", "访客", "制作助理", "导演助理", "作曲助理",
  "助理舞台监督", "音响设计助理", "音乐导演助理", "舞美设计助理", "灯光设计助理",
  "多媒体设计助理",
];

// ─── 资源类型 / 动词（授权面 UI 与行集展开使用）──────────────────────────────

export type ResourceType =
  | "cue_list"
  | "scene"
  | "event"
  | "report"
  | "task"
  | "note"
  | "script_view"
  | "asset";

export type PermissionLevel = "view" | "mount" | "edit" | "manage";

export type AccessResult =
  | { allowed: true }
  | { allowed: false; reason: "needs_approval" | "needs_self_confirm" | "no_entry" };
