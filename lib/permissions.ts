// ─── Atomic Permission Type ────────────────────────────────────────────────────

export type Permission =
  // ─── Root (owner only; not overridable; deferred to #137) ────────────────────
  | "production:delete"
  | "production:transfer_owner"
  | "production:restore_checkpoint"
  // ─── 敏感管理 (owner default; producer needs explicit grant) ──────────────────
  | "production:archive"
  | "production:rename"
  | "production:change_avatar"
  | "production:edit_description"
  | "production:change_type"
  | "production:change_language"
  | "production:manage_integrations"
  | "production:import_members"
  | "production:producer_invite"
  | "production:producer_promote"
  | "production:producer_demote"
  | "production:producer_kick"
  | "contacts:import"
  // ─── 普通管理 - 用户类 ────────────────────────────────────────────────────────
  | "members:invite"
  | "members:kick"
  | "members:change_role"
  | "members:manage_overrides"
  // ─── 普通管理 - 职位模版类 ────────────────────────────────────────────────────
  | "role:create"
  | "role:rename"
  | "role:delete"
  | "role:assign_permission"
  // ─── 普通管理 - 部门/用户组类 ─────────────────────────────────────────────────
  | "dept:create"
  | "dept:dismiss"
  | "dept:rename"
  | "dept:change_type"
  | "dept:add_member"
  | "dept:delete_member"
  | "dept:set_poc"
  | "dept:unset_poc"
  // ─── 普通管理 - 导入类 ────────────────────────────────────────────────────────
  // ─── 普通管理 - 附件隐私类 ────────────────────────────────────────────────────
  // ─── 普通管理 - 构作视图公开类 ───────────────────────────────────────────────
  | "dramaturgy_view:create_public"
  | "dramaturgy_view:delete_public"
  | "dramaturgy_view:overwrite_public"
  // ─── 普通管理 - Task 删除 ────────────────────────────────────────────────────
  // ─── 普通管理 - 角色管理 ──────────────────────────────────────────────────────
  // ─── 普通管理 - 标注体系管理 ──────────────────────────────────────────────────
  // ─── 普通管理 - 评论管理 ──────────────────────────────────────────────────────
  // ─── 普通管理 - 里程碑 ────────────────────────────────────────────────────────
  | "milestone:create"
  | "milestone:manage"
  | "milestone:delete"
  // ─── 普通管理 - 公告 ──────────────────────────────────────────────────────────
  | "announcement:create"
  | "announcement:edit"
  | "announcement:delete"
  // ─── 普通管理 - 其他 ──────────────────────────────────────────────────────────
  | "production:manage_config"
  // ─── 写权限 - 剧本操作权限（bundle，含 implication 层级）────────────────────
  // ─── 写权限 - 剧本领域权限（由操作权限隐含）─────────────────────────────────
  // ─── 写权限 - 场次/章节 ───────────────────────────────────────────────────────
  // ─── 写权限 - 构作视图（个人）────────────────────────────────────────────────
  | "dramaturgy_view:create"
  | "dramaturgy_view:delete"
  | "dramaturgy_view:overwrite"
  // ─── 写权限 - 角色 ────────────────────────────────────────────────────────────
  // ─── 写权限 - 事件（per-event 写操作已迁移至 resource_grant，保留生产级原子权限）──
  // ─── 写权限 - 报告（Report，per-report 写操作已迁移至 resource_grant）──────
  // ─── 写权限 - 项目挂载点 ──────────────────────────────────────────────────────
  | "production:mount"
  | "production:unmount"
  // ─── 写权限 - 附件基础操作 ────────────────────────────────────────────────────
  // ─── 读权限 ───────────────────────────────────────────────────────────────────
  | "contacts:view"
  // ─── 组织特殊权限（由 org_admin_production_grant 授予，见 #136）────────────
  | "org:assign_member"
  | "org:recall_member";

// ─── Permission Context ────────────────────────────────────────────────────────

export type PermissionContext = {
  userId: string;
  isAdmin: boolean;
  // True when userId === production.owner_id.
  isOwner: boolean;
  // Effective permissions from DB role assignments. null = not a member.
  memberPermissions: Set<Permission> | null;
  // Personal overrides — absolute precedence for non-root/non-sensitive permissions.
  // Reserved for Phase 7 owner-granted direct permissions. Currently always empty.
  overrides: Map<Permission, boolean>;
  // Department membership in this production.
  deptIds: string[];
  pocDeptIds: string[];
  // Atomic permissions the user can self-confirm without waiting for approval.
  // = dept zone (Phase 3) + personal zone adjustments from production_member_permission.
  deptFreeApprovalZone: Set<Permission>;
  // Permissions explicitly activated by the user (self-confirmed or approved).
  // Non-base role permissions require a grant to be usable via hasPermission().
  activeGrants: Set<Permission>;
};

// ─── Permission Tier Constants ─────────────────────────────────────────────────

// Root: owner-only, not overridable. Enforcement deferred to #137.
export const ROOT_PERMISSIONS = new Set<Permission>([
  "production:delete",
  "production:transfer_owner",
  "production:restore_checkpoint",
]);

// Sensitive admin: no adminBypass; producer needs explicit owner grant via override.
export const SENSITIVE_ADMIN_PERMISSIONS = new Set<Permission>([
  "production:archive",
  "production:rename",
  "production:change_avatar",
  "production:edit_description",
  "production:change_type",
  "production:change_language",
  "production:manage_integrations",
  "production:import_members",
  "production:producer_invite",
  "production:producer_promote",
  "production:producer_demote",
  "production:producer_kick",
  "contacts:import",
]);

// Permissions excluded from role templates (cannot be granted via role:assign_permission).
export const ROLE_TEMPLATE_EXCLUDED = new Set<Permission>([
  ...ROOT_PERMISSIONS,
  ...SENSITIVE_ADMIN_PERMISSIONS,
  "role:create",
  "role:rename",
  "role:delete",
  "role:assign_permission",
]);

// Permissions that appear in the admin panel (non-SENSITIVE, non-ROOT).
// Gate: if memberPermissions contains ANY of these → user can enter admin panel.
export const ADMIN_PANEL_PERMISSIONS = new Set<Permission>([
  // 成员管理
  "members:invite",
  "members:kick",
  "members:change_role",
  "members:manage_overrides",
  // 职位管理
  "role:create",
  "role:rename",
  "role:delete",
  "role:assign_permission",
  // 部门管理
  "dept:create",
  "dept:rename",
  "dept:dismiss",
  "dept:change_type",
  "dept:add_member",
  "dept:delete_member",
  "dept:set_poc",
  "dept:unset_poc",
  // 公告
  "announcement:create",
  "announcement:edit",
  "announcement:delete",
  // 里程碑
  "milestone:create",
  "milestone:manage",
  "milestone:delete",
]);

// ─── Script Operation Implication ─────────────────────────────────────────────
// ─── Core Permission Check ─────────────────────────────────────────────────────

export function hasPermission(perm: Permission, ctx: PermissionContext): boolean {
  // Root: superadmin or production owner
  if (ROOT_PERMISSIONS.has(perm)) return ctx.isAdmin || ctx.isOwner;

  // Not a member: only superadmin or owner can proceed
  if (ctx.memberPermissions === null) return ctx.isAdmin || ctx.isOwner;

  // Sensitive admin: owner has it directly; others need explicit override (Phase 7 approval flow)
  if (SENSITIVE_ADMIN_PERMISSIONS.has(perm)) {
    return ctx.isOwner || ctx.overrides.get(perm) === true;
  }

  // Personal override has absolute precedence for all other permissions
  if (ctx.overrides.has(perm)) return ctx.overrides.get(perm)!;

  // Superadmin / owner bypass for non-root, non-sensitive permissions
  if (ctx.isAdmin || ctx.isOwner) return true;

  // All other permissions require an explicit active grant (self-confirmed or approved).
  return ctx.activeGrants.has(perm);
}

// ─── Scoped Permission Check ───────────────────────────────────────────────────
// anyPerm OR (basePerm AND scopeCheck). scopeCheck is pre-evaluated by the caller.
// Examples:
//   self-scoped: scopeCheck = resource.createdBy === ctx.userId
//   dept-scoped: scopeCheck = ctx.deptIds.includes(resource.deptId)
//   dept+POC:    scopeCheck = ctx.pocDeptIds.includes(resource.deptId)

export function hasScopedPermission(
  basePerm: Permission,
  anyPerm: Permission,
  scopeCheck: boolean,
  ctx: PermissionContext,
): boolean {
  return hasPermission(anyPerm, ctx) || (hasPermission(basePerm, ctx) && scopeCheck);
}

// ─── Member Base Permissions ───────────────────────────────────────────────────
// Default view-class permissions included in every new role template.
// NOT a bypass — these take effect only after self-confirm writes an active grant.
// Admins can remove any of these from a specific role; the grant then does not exist.
//
// (#158) Phase 5 complete: bypass removed. Members confirm view grants via Level 1
// notification on first production entry (see AppShell ViewGrantNotification).

export const MEMBER_BASE_PERMISSIONS: readonly Permission[] = [
  "contacts:view",
];

// ─── Dramaturgy Full Set ───────────────────────────────────────────────────────
const DRAMATURGY_FULL_SET: readonly Permission[] = [
];

// ─── SM Event Permissions ──────────────────────────────────────────────────────
// Per-event 写权限（event:edit 等）已迁移至 resource_grant；SM 通过 dept.permissions[]
// 配置获得 event 的免审批区间，不再需要原子权限。
// ─── 制作人 Full Set ───────────────────────────────────────────────────────────
// Producer gets all 普通管理 + 写权限 + 读权限 by default.
const PRODUCER_ADMIN_PERMS: readonly Permission[] = [
  "members:invite",
  "members:kick",
  "members:change_role",
  "members:manage_overrides",
  "role:create",
  "role:rename",
  "role:delete",
  "role:assign_permission",
  "dept:create",
  "dept:dismiss",
  "dept:rename",
  "dept:change_type",
  "dept:add_member",
  "dept:delete_member",
  "dept:set_poc",
  "dept:unset_poc",
  "dramaturgy_view:create_public",
  "dramaturgy_view:delete_public",
  "dramaturgy_view:overwrite_public",
  "milestone:create",
  "milestone:manage",
  "milestone:delete",
  "announcement:create",
  "announcement:edit",
  "announcement:delete",
  
  
  "production:manage_config",
];

const PRODUCER_WRITE_PERMS: readonly Permission[] = [
  ...DRAMATURGY_FULL_SET,
  "dramaturgy_view:create",
  "dramaturgy_view:delete",
  "dramaturgy_view:overwrite",
  
  "production:mount",
  "production:unmount",
];

const PRODUCER_READ_PERMS: readonly Permission[] = [
  ...MEMBER_BASE_PERMISSIONS,
];

// ─── Role Template Permissions ─────────────────────────────────────────────────
// Initial DB seed data. Permissions here are incremental over MEMBER_BASE_PERMISSIONS.
// Keys match lib/roles.ts ROLE_GROUPS role strings exactly.

export const ROLE_TEMPLATE_PERMISSIONS: Record<string, readonly Permission[]> = {
  // 制作侧
  "制作人": [
    ...PRODUCER_ADMIN_PERMS,
    ...PRODUCER_WRITE_PERMS,
    ...PRODUCER_READ_PERMS,
  ],

  // 创作组
  "编剧": [
    ...DRAMATURGY_FULL_SET,
    ...MEMBER_BASE_PERMISSIONS,
  ],
  "戏剧构作": [
    ...DRAMATURGY_FULL_SET,
    ...MEMBER_BASE_PERMISSIONS,
  ],
  "导演": [
    ...MEMBER_BASE_PERMISSIONS,
  ],
  "副导演": [
    ...MEMBER_BASE_PERMISSIONS,
  ],
  "音乐导演": [
    "production:mount",
    ...MEMBER_BASE_PERMISSIONS,
  ],
  "作曲": [
    "production:mount",
    ...MEMBER_BASE_PERMISSIONS,
  ],
  "编曲": [
    "production:mount",
    ...MEMBER_BASE_PERMISSIONS,
  ],

  // 设计组
  "舞美设计": [
    "production:mount",
    ...MEMBER_BASE_PERMISSIONS,
  ],
  "灯光设计": [
    "production:mount",
    ...MEMBER_BASE_PERMISSIONS,
  ],
  "多媒体设计": [
    "production:mount",
    ...MEMBER_BASE_PERMISSIONS,
  ],
  "服化设计": [
    ...MEMBER_BASE_PERMISSIONS,
  ],
  "音响设计": [
    "production:mount",
    ...MEMBER_BASE_PERMISSIONS,
  ],

  // 执行组
  "音响执行": [
    "production:mount",
    ...MEMBER_BASE_PERMISSIONS,
  ],
  "灯光编程": [...MEMBER_BASE_PERMISSIONS],
  "技术导演": [...MEMBER_BASE_PERMISSIONS],
  "执行": [...MEMBER_BASE_PERMISSIONS],

  // 舞台监督
  "舞台监督": [
    ...MEMBER_BASE_PERMISSIONS,
  ],

  // 宣发/外围
  "新媒体": [
    "production:mount",
    ...MEMBER_BASE_PERMISSIONS,
  ],
  "侧写": [
    "production:mount",
    ...MEMBER_BASE_PERMISSIONS,
  ],

  // 演员
  "演员": [...MEMBER_BASE_PERMISSIONS],
  "群演": [...MEMBER_BASE_PERMISSIONS],
  "乐手": [...MEMBER_BASE_PERMISSIONS],

  // 特殊岗位
  "肢体指导": [...MEMBER_BASE_PERMISSIONS],
  "编舞": [...MEMBER_BASE_PERMISSIONS],

  // 特殊内置
  "访客": [...MEMBER_BASE_PERMISSIONS],
};

// ─── Assistant Role Migration Map ─────────────────────────────────────────────
// Not in templates; used only for backfilling existing production_member data.

export const ASSISTANT_ROLE_MIGRATION: Record<string, readonly Permission[]> = {
  "制作助理": [
  ],
  "作曲助理": ROLE_TEMPLATE_PERMISSIONS["作曲"],
  "助理舞台监督": ROLE_TEMPLATE_PERMISSIONS["舞台监督"],
  "音响设计助理": ROLE_TEMPLATE_PERMISSIONS["音响设计"],
  "导演助理": [],
  "音乐导演助理": ROLE_TEMPLATE_PERMISSIONS["音乐导演"],
  "舞美设计助理": ROLE_TEMPLATE_PERMISSIONS["舞美设计"],
  "灯光设计助理": ROLE_TEMPLATE_PERMISSIONS["灯光设计"],
  "多媒体设计助理": ROLE_TEMPLATE_PERMISSIONS["多媒体设计"],
  "服化设计助理": ROLE_TEMPLATE_PERMISSIONS["服化设计"],
  "编剧助理": ROLE_TEMPLATE_PERMISSIONS["编剧"],
};

// ─── All permission keys as a runtime constant ─────────────────────────────────
export const ALL_PERMISSIONS: readonly Permission[] = [
  "production:delete", "production:transfer_owner", "production:restore_checkpoint",
  "production:archive", "production:rename", "production:change_avatar",
  "production:edit_description", "production:change_type", "production:change_language",
  "production:manage_integrations", "production:import_members",
  "production:producer_invite", "production:producer_promote",
  "production:producer_demote", "production:producer_kick",
  "contacts:import",
  "members:invite", "members:kick", "members:change_role", "members:manage_overrides",
  "role:create", "role:rename", "role:delete", "role:assign_permission",
  "dept:create", "dept:dismiss", "dept:rename", "dept:change_type",
  "dept:add_member", "dept:delete_member", "dept:set_poc", "dept:unset_poc",
  "dramaturgy_view:create_public", "dramaturgy_view:delete_public", "dramaturgy_view:overwrite_public",
  
  "production:manage_config",
  "milestone:create", "milestone:manage", "milestone:delete",
  "announcement:create", "announcement:edit", "announcement:delete",
  "dramaturgy_view:create", "dramaturgy_view:delete", "dramaturgy_view:overwrite",
  
  
  "production:mount", "production:unmount",
  "contacts:view", 
  
  "org:assign_member", "org:recall_member",
];

// ─── Phase 1 (#158): Resource Grant 基础设施 ──────────────────────────────────

// 资源域类型（与 resource_grant.resource_type 对应）
export type ResourceType =
  | "cue_list"
  | "scene"
  | "event"
  | "report"
  | "task"
  | "note"
  | "script_view"
  | "asset";

// resource_grant.permission_level 标准线性层级（高级包含低级，由代码约定，非 DB 强制）。
// event/report 使用资源专属词汇（publish/edit_published/revoke），由应用层按 resource_type 定义。
export type PermissionLevel = "view" | "mount" | "edit" | "manage";

// canAccess() 返回结果。Phase 1 只会返回 allowed: true/false。
// Phase 2+ 开始返回 needs_self_confirm / needs_approval，驱动前端 UX。
export type AccessResult =
  | { allowed: true }
  | { allowed: false; reason: "needs_self_confirm" }
  | { allowed: false; reason: "needs_approval" };

// ─── Dept-Assignable Permissions ──────────────────────────────────────────────
// 可写入 production_dept.permissions[] 的权限集合。
// 排除 root-only、sensitive-admin 以及组织级权限（不属于演出内权限配置范围）。

const DEPT_EXCLUDED: Set<Permission> = new Set<Permission>([
  ...ROOT_PERMISSIONS,
  ...SENSITIVE_ADMIN_PERMISSIONS,
  "org:assign_member",
  "org:recall_member",
]);

export const DEPT_ASSIGNABLE_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (p) => !DEPT_EXCLUDED.has(p),
);

// ─── canAccess ─────────────────────────────────────────────────────────────────
// Phase 1：内部调用 hasPermission() 作为回落，用户无感知变化。
// Phase 4+ 起，先查 resource_grant 表，未命中再查免审批区间，最终走申请流。

export function canAccess(
  ctx: PermissionContext,
  perm: Permission,
  _resource?: { type: ResourceType; id?: string },
): AccessResult {
  if (hasPermission(perm, ctx)) return { allowed: true };
  // Eligible for self-confirm: role grants eligibility, dept zone also grants eligibility.
  // Both paths require the user to explicitly confirm before the permission becomes active.
  if ((ctx.memberPermissions?.has(perm) ?? false) || ctx.deptFreeApprovalZone.has(perm)) {
    return { allowed: false, reason: "needs_self_confirm" };
  }
  return { allowed: false, reason: "needs_approval" };
}
