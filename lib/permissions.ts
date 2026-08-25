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
  "node:member/", "node:role/", "node:dept/",
  "node:milestone/", "node:phase/", "node:announcement/", "node:*",
];

/**
 * 前缀命中后仍不算管理面资格的面。
 *
 * dept 类型自 #327 起同时承载治理面（建/删/改部门、成员、POC、权限行）与 notes 面
 * （给某部门提备注）——并类型前两者是 dept / org_dept 两个类型，靠**类型边界**分开，
 * `node:org_dept/` 这个前缀天然扫不到 notes。并完之后前缀扫得到了，而
 * `node:dept/<D>/notes@create` 的通配形正是导演类模板键（见 lib/templates），
 * 不排掉就等于「能替部门提备注 ⇒ 能进管理后台」，是一次静默放宽。
 *
 * 用「解析出 sub」而不是再加一条前缀：resource_id 位可以是具体部门 id
 * （`node:dept/<uuid>/notes@create`），前缀匹配盖不住那种形态。
 */
const ADMIN_PANEL_EXCLUDED_SUBS: readonly string[] = ["notes"];

function isAdminPanelKey(key: string): boolean {
  if (!ADMIN_PANEL_NODE_PREFIXES.some((p) => key.startsWith(p))) return false;
  // node:<type>/<id>[/<sub>]@<verb> —— 取 sub 段（没有 sub 段即主面）
  const body = key.slice("node:".length).split("@")[0] ?? "";
  const sub = body.split("/").slice(2).join("/");
  return !ADMIN_PANEL_EXCLUDED_SUBS.includes(sub);
}

export function hasAdminPanelEligibility(memberPermissions: Set<string> | null): boolean {
  if (memberPermissions === null) return false;
  for (const key of memberPermissions) {
    if (isAdminPanelKey(key)) return true;
  }
  return false;
}

// ─── 角色名单已随模版走（#163）──────────────────────────────────────────────
//
// 原 ROLE_NAMES 是一份全局名单，所有类型的项目建出来都是同一批角色。多套模版之后
// 它不成立了——音乐专辑没有「追光」「抢妆师」。名单现在是每套模版自己的一个 slot：
//   lib/templates/*.ts 的 roles.names
// 「默认模版名单不是白名单」这条纪律不变：在用的自定义 role 不因不在名单里被删。

// ─── 资源类型 / 动词（授权面 UI 与行集展开使用）──────────────────────────────

export type ResourceType =
  | "cue_list"
  | "scene"
  | "event"
  | "report"
  | "task"
  | "note"
  | "script_view"
  | "asset"
  | "wiki";

export type PermissionLevel = "view" | "mount" | "edit" | "manage";

export type AccessResult =
  | { allowed: true }
  | { allowed: false; reason: "needs_approval" | "needs_self_confirm" | "no_entry" };
