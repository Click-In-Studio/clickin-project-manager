// ─── Atomic Permission Type ────────────────────────────────────────────────────

export type Permission =
  // ─── Root (owner only; not overridable; deferred to #137) ────────────────────
  | "production:delete"
  | "production:transfer_owner"
  | "production:restore_checkpoint"
  // ─── 敏感管理 (owner default; producer needs explicit grant) ──────────────────
  | "production:archive"
  | "production:rename"
  | "production:change_type"
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
  | "script:import"
  | "dramaturgy:import"
  // ─── 普通管理 - 附件隐私类 ────────────────────────────────────────────────────
  | "asset:view_any"
  | "asset:delete_any"
  | "asset:rename_any"
  | "asset:change_type_any"
  | "asset:overwrite_any"
  | "asset:mount_any"
  | "asset:unmount_any"
  // ─── 普通管理 - Cue _any 类 ───────────────────────────────────────────────────
  | "cue_list:create_any"
  | "cue_list:delete_any"
  | "cue_list:rename_any"
  | "cue_list:reorder_any"
  | "cue_list:edit_abbr_any"
  | "cue_list:edit_description_any"
  | "cue_list:manage_permissions_any"
  | "cue:create_any"
  | "cue:delete_any"
  | "cue:renumber_any"
  | "cue:rename_any"
  | "cue:edit_description_any"
  | "cue:move_any"
  | "cue:mount_any"
  // ─── 普通管理 - 构作视图公开类 ───────────────────────────────────────────────
  | "dramaturgy_view:create_public"
  | "dramaturgy_view:delete_public"
  | "dramaturgy_view:overwrite_public"
  // ─── 普通管理 - 已发布内容修改门控 ───────────────────────────────────────────
  | "event:modify_published"
  | "event:revoke"
  | "event:delete"
  | "report:modify_published"
  | "report:revoke"
  // ─── 普通管理 - Tech Req 删除 ─────────────────────────────────────────────────
  | "event:delete_tech_req_any"
  // ─── 普通管理 - 角色管理 ──────────────────────────────────────────────────────
  | "character:delete"
  // ─── 普通管理 - 标注体系管理 ──────────────────────────────────────────────────
  | "tag_group:create"
  | "tag_group:delete"
  | "tag_group:rename"
  | "tag_group:edit_range_config"
  | "tag_group:set_default_option"
  | "tag_group:set_lyric_split"
  | "tag_group:reorder"
  | "tag_option:create"
  | "tag_option:delete"
  | "tag_option:rename"
  | "tag_option:edit_color"
  | "tag_option:reorder"
  // ─── 普通管理 - 评论管理 ──────────────────────────────────────────────────────
  | "script:edit_comment_any"
  | "script:delete_comment_any"
  | "cue:edit_comment_any"
  | "cue:delete_comment_any"
  | "report:edit_comment_any"
  | "report:delete_comment_any"
  | "note:edit_comment_any"
  | "note:delete_comment_any"
  // ─── 普通管理 - 其他 ──────────────────────────────────────────────────────────
  | "production:manage_config"
  // ─── 写权限 - 剧本操作权限（bundle，含 implication 层级）────────────────────
  | "script:manage"
  | "script:edit"
  | "script:annotate"
  // ─── 写权限 - 剧本领域权限（由操作权限隐含）─────────────────────────────────
  | "rehearsal_mark:create"
  | "rehearsal_mark:edit"
  | "rehearsal_mark:delete"
  | "rehearsal_mark:move"
  | "script:create_block"
  | "script:delete_block"
  | "script:edit_block"
  | "script:set_character"
  | "script:set_type"
  | "script:set_tag"
  | "script:reorder"
  | "script:mount"
  // ─── 写权限 - 场次/章节 ───────────────────────────────────────────────────────
  | "scene:create"
  | "scene:delete"
  | "scene:rename"
  | "scene:renumber"
  | "scene:change_type"
  | "scene:edit_synopsis"
  | "scene:edit_action_line"
  | "scene:edit_music"
  | "scene:edit_stage_notes"
  | "scene:edit_expected_duration"
  | "scene:mount"
  // ─── 写权限 - 构作视图（个人）────────────────────────────────────────────────
  | "dramaturgy_view:create"
  | "dramaturgy_view:delete"
  | "dramaturgy_view:overwrite"
  // ─── 写权限 - 角色 ────────────────────────────────────────────────────────────
  | "character:create"
  | "character:rename"
  | "character:change_type"
  | "character:set_members"
  | "character:edit_gender"
  | "character:edit_biography"
  | "character:edit_role_type"
  // ─── 写权限 - Cue ─────────────────────────────────────────────────────────────
  | "cue_list:create"
  | "cue_list:delete"
  | "cue_list:rename"
  | "cue_list:reorder"
  | "cue_list:edit_abbr"
  | "cue_list:edit_description"
  | "cue_list:manage_permissions"
  | "cue:create"
  | "cue:delete"
  | "cue:renumber"
  | "cue:rename"
  | "cue:edit_description"
  | "cue:move"
  | "cue:mount"
  // ─── 写权限 - 事件 ────────────────────────────────────────────────────────────
  | "event:create"
  | "event:edit"
  | "event:publish"
  | "event:create_schedule"
  | "event:edit_schedule"
  | "event:delete_schedule"
  | "event:assign_participants"
  | "event:assign_schedule_participants"
  | "event:edit_call"
  | "event:create_tech_req"
  | "event:edit_tech_req"
  | "event:assign_tech_req"
  | "event:delete_tech_req"
  | "event:create_tech_req_any"
  | "event:edit_tech_req_any"
  | "event:assign_tech_req_any"
  // ─── 写权限 - 报告（Report）──────────────────────────────────────────────────
  | "report:create"
  | "report:edit"
  | "report:publish"
  | "report:delete"
  | "report:create_note"
  | "report:edit_note"
  | "report:delete_note"
  | "report:create_note_any"
  | "report:edit_note_any"
  | "report:delete_note_any"
  // ─── 写权限 - 项目挂载点 ──────────────────────────────────────────────────────
  | "production:mount"
  | "production:unmount"
  // ─── 写权限 - 附件基础操作 ────────────────────────────────────────────────────
  | "asset:create"
  | "asset:rename"
  | "asset:overwrite"
  | "asset:change_type"
  | "asset:delete"
  | "asset:mount"
  | "asset:unmount"
  // ─── 读权限 ───────────────────────────────────────────────────────────────────
  | "scene:view"
  | "character:view"
  | "script:view"
  | "cue_list:view"
  | "cue:view"
  | "contacts:view"
  | "event:view"
  | "event:view_call_sheet"
  | "event:view_call_sheet_any"
  | "event:view_tech_req"
  | "event:view_tech_req_any"
  | "event:follow"
  | "report:view"
  | "asset:view"
  | "asset:download"
  | "asset:download_any"
  | "asset:share"
  | "asset:share_downloadable"
  | "asset:share_any"
  | "asset:share_any_downloadable"
  | "script:comment"
  | "cue:comment"
  | "report:reply"
  | "note:comment"
  // ─── 组织特殊权限（由 org_admin_production_grant 授予，见 #136）────────────
  | "org:assign_member"
  | "org:recall_member";

// ─── Permission Context ────────────────────────────────────────────────────────

export type PermissionContext = {
  userId: string;
  isAdmin: boolean;
  // Effective permissions from DB role assignments. null = not a member.
  memberPermissions: Set<Permission> | null;
  // Personal overrides — absolute precedence for non-root/non-sensitive permissions.
  overrides: Map<Permission, boolean>;
  // Department membership in this production.
  deptIds: string[];
  pocDeptIds: string[];
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
  "production:change_type",
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

// ─── Script Operation Implication ─────────────────────────────────────────────
// script:manage ⊃ script:edit ⊃ script:annotate

const SCRIPT_ANNOTATE_DOMAIN = new Set<Permission>([
  "rehearsal_mark:create",
  "rehearsal_mark:edit",
  "rehearsal_mark:delete",
  "rehearsal_mark:move",
]);

const SCRIPT_EDIT_DOMAIN = new Set<Permission>([
  ...SCRIPT_ANNOTATE_DOMAIN,
  "script:create_block",
  "script:delete_block",
  "script:edit_block",
  "script:set_character",
  "script:set_type",
  "script:set_tag",
  "script:reorder",
  "script:mount",
]);

const SCRIPT_MANAGE_DOMAIN = new Set<Permission>([
  ...SCRIPT_EDIT_DOMAIN,
  "scene:create",
  "scene:delete",
]);

// ─── Core Permission Check ─────────────────────────────────────────────────────

export function hasPermission(perm: Permission, ctx: PermissionContext): boolean {
  // Root: only superadmin for now (owner short-circuit deferred to #137)
  if (ROOT_PERMISSIONS.has(perm)) return ctx.isAdmin;

  // Not a member: only superadmin can proceed
  if (ctx.memberPermissions === null) return ctx.isAdmin;

  // Sensitive admin: only via explicit override (no adminBypass, no role default)
  if (SENSITIVE_ADMIN_PERMISSIONS.has(perm)) {
    return ctx.overrides.get(perm) === true;
  }

  // Personal override has absolute precedence for all other permissions
  if (ctx.overrides.has(perm)) return ctx.overrides.get(perm)!;

  // Superadmin bypass for non-root, non-sensitive permissions
  if (ctx.isAdmin) return true;

  // Operation implication: script:manage / script:edit / script:annotate
  if (SCRIPT_MANAGE_DOMAIN.has(perm) && ctx.memberPermissions.has("script:manage")) return true;
  if (SCRIPT_EDIT_DOMAIN.has(perm) && ctx.memberPermissions.has("script:edit")) return true;
  if (SCRIPT_ANNOTATE_DOMAIN.has(perm) && ctx.memberPermissions.has("script:annotate")) return true;

  return ctx.memberPermissions.has(perm);
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

// ─── Mount Permission Check ────────────────────────────────────────────────────
// Dual verification: asset-side AND entity-side must both pass.
// entityPerm: 'scene:mount' | 'script:mount' | 'cue:mount' | 'production:mount'
// isOwnAsset: whether asset.uploadedBy === ctx.userId

export function hasMountPermission(
  entityPerm: Permission,
  isOwnAsset: boolean,
  ctx: PermissionContext,
): boolean {
  const assetPerm: Permission = isOwnAsset ? "asset:mount" : "asset:mount_any";
  return hasPermission(assetPerm, ctx) && hasPermission(entityPerm, ctx);
}

// ─── Member Base Permissions ───────────────────────────────────────────────────
// All members receive these regardless of job title.

export const MEMBER_BASE_PERMISSIONS: readonly Permission[] = [
  "scene:view",
  "character:view",
  "script:view",
  "cue_list:view",
  "cue:view",
  "contacts:view",
  "event:view",
  "event:view_call_sheet",
  "event:follow",
  "asset:view",
  "asset:download",
  "asset:share",
  "report:view",
];

// ─── Cue Operation Full Set ────────────────────────────────────────────────────
const CUE_FULL_SET: readonly Permission[] = [
  "cue_list:create",
  "cue_list:delete",
  "cue_list:rename",
  "cue_list:reorder",
  "cue_list:edit_abbr",
  "cue_list:edit_description",
  "cue_list:manage_permissions",
  "cue:create",
  "cue:delete",
  "cue:renumber",
  "cue:rename",
  "cue:edit_description",
  "cue:move",
];

// ─── Dramaturgy Full Set ───────────────────────────────────────────────────────
const DRAMATURGY_FULL_SET: readonly Permission[] = [
  "scene:create",
  "scene:rename",
  "scene:renumber",
  "scene:change_type",
  "scene:edit_synopsis",
  "scene:edit_action_line",
  "scene:edit_music",
  "scene:edit_stage_notes",
  "scene:edit_expected_duration",
  "character:create",
  "character:rename",
  "character:change_type",
  "character:set_members",
  "character:edit_gender",
  "character:edit_biography",
  "character:edit_role_type",
  "tag_group:create",
  "tag_group:delete",
  "tag_group:rename",
  "tag_group:edit_range_config",
  "tag_group:set_default_option",
  "tag_group:set_lyric_split",
  "tag_group:reorder",
  "tag_option:create",
  "tag_option:delete",
  "tag_option:rename",
  "tag_option:edit_color",
  "tag_option:reorder",
];

// ─── SM Event Permissions ──────────────────────────────────────────────────────
const SM_EVENT_PERMS: readonly Permission[] = [
  "event:create",
  "event:edit",
  "event:publish",
  "event:view_call_sheet_any",
  "event:view_tech_req",
  "event:view_tech_req_any",
  "event:edit_call",
  "event:delete_tech_req_any",
  "event:create_schedule",
  "event:edit_schedule",
  "event:delete_schedule",
  "event:assign_participants",
  "event:assign_schedule_participants",
];

const DIRECTOR_EVENT_PERMS: readonly Permission[] = [
  "event:view_tech_req_any",
  "event:create_schedule",
  "event:edit_schedule",
  "event:delete_schedule",
  "event:assign_participants",
  "event:assign_schedule_participants",
];

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
  "script:import",
  "dramaturgy:import",
  "asset:view_any",
  "asset:delete_any",
  "asset:rename_any",
  "asset:change_type_any",
  "asset:overwrite_any",
  "asset:mount_any",
  "asset:unmount_any",
  "cue_list:create_any",
  "cue_list:delete_any",
  "cue_list:rename_any",
  "cue_list:reorder_any",
  "cue_list:edit_abbr_any",
  "cue_list:edit_description_any",
  "cue_list:manage_permissions_any",
  "cue:create_any",
  "cue:delete_any",
  "cue:renumber_any",
  "cue:rename_any",
  "cue:edit_description_any",
  "cue:move_any",
  "cue:mount_any",
  "dramaturgy_view:create_public",
  "dramaturgy_view:delete_public",
  "dramaturgy_view:overwrite_public",
  "event:modify_published",
  "event:revoke",
  "event:delete",
  "report:modify_published",
  "report:revoke",
  "event:delete_tech_req_any",
  "character:delete",
  "tag_group:create",
  "tag_group:delete",
  "tag_group:rename",
  "tag_group:edit_range_config",
  "tag_group:set_default_option",
  "tag_group:set_lyric_split",
  "tag_group:reorder",
  "tag_option:create",
  "tag_option:delete",
  "tag_option:rename",
  "tag_option:edit_color",
  "tag_option:reorder",
  "script:edit_comment_any",
  "script:delete_comment_any",
  "cue:edit_comment_any",
  "cue:delete_comment_any",
  "report:edit_comment_any",
  "report:delete_comment_any",
  "note:edit_comment_any",
  "note:delete_comment_any",
  "production:manage_config",
];

const PRODUCER_WRITE_PERMS: readonly Permission[] = [
  "script:manage",
  ...DRAMATURGY_FULL_SET,
  "dramaturgy_view:create",
  "dramaturgy_view:delete",
  "dramaturgy_view:overwrite",
  ...CUE_FULL_SET,
  ...SM_EVENT_PERMS,
  "event:create_tech_req",
  "event:edit_tech_req",
  "event:assign_tech_req",
  "event:delete_tech_req",
  "event:create_tech_req_any",
  "event:edit_tech_req_any",
  "event:assign_tech_req_any",
  "report:create",
  "report:edit",
  "report:publish",
  "report:delete",
  "report:create_note",
  "report:edit_note",
  "report:delete_note",
  "report:create_note_any",
  "report:edit_note_any",
  "report:delete_note_any",
  "production:mount",
  "production:unmount",
  "asset:create",
  "asset:rename",
  "asset:overwrite",
  "asset:change_type",
  "asset:delete",
  "asset:mount",
  "asset:unmount",
  "event:view_call_sheet_any",
];

const PRODUCER_READ_PERMS: readonly Permission[] = [
  ...MEMBER_BASE_PERMISSIONS,
  "event:view_call_sheet_any",
  "event:view_tech_req",
  "event:view_tech_req_any",
  "asset:download_any",
  "asset:share_downloadable",
  "asset:share_any",
  "asset:share_any_downloadable",
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
    "script:manage",
    ...DRAMATURGY_FULL_SET,
  ],
  "戏剧构作": [
    "script:annotate",
    ...DRAMATURGY_FULL_SET,
  ],
  "导演": [
    "script:annotate",
    "script:mount",
    "scene:mount",
    ...DIRECTOR_EVENT_PERMS,
  ],
  "副导演": [
    ...DIRECTOR_EVENT_PERMS,
  ],
  "音乐导演": [
    "script:annotate",
    "script:mount",
    "scene:mount",
    "production:mount",
    ...DIRECTOR_EVENT_PERMS,
    ...CUE_FULL_SET,
  ],
  "作曲": [
    "script:annotate",
    "scene:edit_music",
    "script:mount",
    "scene:mount",
    "production:mount",
    ...CUE_FULL_SET,
  ],
  "编曲": [
    "script:annotate",
    "script:mount",
    "scene:mount",
    "production:mount",
    ...CUE_FULL_SET,
  ],

  // 设计组
  "舞美设计": [
    "production:mount",
    "scene:mount",
    "script:mount",
    ...CUE_FULL_SET,
  ],
  "灯光设计": [
    "production:mount",
    ...CUE_FULL_SET,
  ],
  "多媒体设计": [
    "production:mount",
    ...CUE_FULL_SET,
  ],
  "服化设计": [
    ...CUE_FULL_SET,
  ],
  "音响设计": [
    "production:mount",
    ...CUE_FULL_SET,
  ],

  // 执行组
  "音响执行": [
    "script:mount",
    "scene:mount",
    "production:mount",
  ],
  "灯光编程": [],
  "技术导演": [],
  "执行": [],

  // 舞台监督
  "舞台监督": [
    ...SM_EVENT_PERMS,
    ...CUE_FULL_SET,
  ],

  // 宣发/外围
  "新媒体": [
    "production:mount",
  ],
  "侧写": [
    "script:mount",
    "scene:mount",
    "production:mount",
  ],

  // 演员
  "演员": [],
  "群演": [],
  "乐手": [],

  // 特殊岗位
  "肢体指导": [],
  "编舞": [],

  // 特殊内置
  "访客": [],
};

// ─── Assistant Role Migration Map ─────────────────────────────────────────────
// Not in templates; used only for backfilling existing production_member data.

export const ASSISTANT_ROLE_MIGRATION: Record<string, readonly Permission[]> = {
  "制作助理": [
    ...SM_EVENT_PERMS,
    "event:create_tech_req_any",
    "event:edit_tech_req_any",
    "event:assign_tech_req_any",
  ],
  "作曲助理": ROLE_TEMPLATE_PERMISSIONS["作曲"],
  "助理舞台监督": ROLE_TEMPLATE_PERMISSIONS["舞台监督"],
  "音响设计助理": ROLE_TEMPLATE_PERMISSIONS["音响设计"],
  "导演助理": [...DIRECTOR_EVENT_PERMS],
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
  "production:archive", "production:rename", "production:change_type",
  "production:manage_integrations", "production:import_members",
  "production:producer_invite", "production:producer_promote",
  "production:producer_demote", "production:producer_kick",
  "contacts:import",
  "members:invite", "members:kick", "members:change_role", "members:manage_overrides",
  "role:create", "role:rename", "role:delete", "role:assign_permission",
  "dept:create", "dept:dismiss", "dept:rename", "dept:change_type",
  "dept:add_member", "dept:delete_member", "dept:set_poc", "dept:unset_poc",
  "script:import", "dramaturgy:import",
  "asset:view_any", "asset:delete_any", "asset:rename_any",
  "asset:change_type_any", "asset:overwrite_any", "asset:mount_any", "asset:unmount_any",
  "cue_list:create_any", "cue_list:delete_any", "cue_list:rename_any",
  "cue_list:reorder_any", "cue_list:edit_abbr_any", "cue_list:edit_description_any",
  "cue_list:manage_permissions_any",
  "cue:create_any", "cue:delete_any", "cue:renumber_any", "cue:rename_any",
  "cue:edit_description_any", "cue:move_any", "cue:mount_any",
  "dramaturgy_view:create_public", "dramaturgy_view:delete_public", "dramaturgy_view:overwrite_public",
  "event:modify_published", "event:revoke", "event:delete",
  "report:modify_published", "report:revoke",
  "event:delete_tech_req_any",
  "character:delete",
  "tag_group:create", "tag_group:delete", "tag_group:rename", "tag_group:edit_range_config",
  "tag_group:set_default_option", "tag_group:set_lyric_split", "tag_group:reorder",
  "tag_option:create", "tag_option:delete", "tag_option:rename",
  "tag_option:edit_color", "tag_option:reorder",
  "script:edit_comment_any", "script:delete_comment_any",
  "cue:edit_comment_any", "cue:delete_comment_any",
  "report:edit_comment_any", "report:delete_comment_any",
  "note:edit_comment_any", "note:delete_comment_any",
  "production:manage_config",
  "script:manage", "script:edit", "script:annotate",
  "rehearsal_mark:create", "rehearsal_mark:edit", "rehearsal_mark:delete", "rehearsal_mark:move",
  "script:create_block", "script:delete_block", "script:edit_block",
  "script:set_character", "script:set_type", "script:set_tag", "script:reorder", "script:mount",
  "scene:create", "scene:delete", "scene:rename", "scene:renumber", "scene:change_type",
  "scene:edit_synopsis", "scene:edit_action_line", "scene:edit_music",
  "scene:edit_stage_notes", "scene:edit_expected_duration", "scene:mount",
  "dramaturgy_view:create", "dramaturgy_view:delete", "dramaturgy_view:overwrite",
  "character:create", "character:rename", "character:change_type",
  "character:set_members", "character:edit_gender", "character:edit_biography",
  "character:edit_role_type",
  "cue_list:create", "cue_list:delete", "cue_list:rename", "cue_list:reorder",
  "cue_list:edit_abbr", "cue_list:edit_description", "cue_list:manage_permissions",
  "cue:create", "cue:delete", "cue:renumber", "cue:rename",
  "cue:edit_description", "cue:move", "cue:mount",
  "event:create", "event:edit", "event:publish",
  "event:create_schedule", "event:edit_schedule", "event:delete_schedule",
  "event:assign_participants", "event:assign_schedule_participants",
  "event:edit_call",
  "event:create_tech_req", "event:edit_tech_req", "event:assign_tech_req", "event:delete_tech_req",
  "event:create_tech_req_any", "event:edit_tech_req_any", "event:assign_tech_req_any",
  "report:create", "report:edit", "report:publish", "report:delete",
  "report:create_note", "report:edit_note", "report:delete_note",
  "report:create_note_any", "report:edit_note_any", "report:delete_note_any",
  "production:mount", "production:unmount",
  "asset:create", "asset:rename", "asset:overwrite", "asset:change_type",
  "asset:delete", "asset:mount", "asset:unmount",
  "scene:view", "character:view", "script:view", "cue_list:view", "cue:view",
  "contacts:view", "event:view", "event:view_call_sheet", "event:view_call_sheet_any",
  "event:view_tech_req", "event:view_tech_req_any", "event:follow",
  "report:view", "asset:view", "asset:download", "asset:download_any",
  "asset:share", "asset:share_downloadable", "asset:share_any", "asset:share_any_downloadable",
  "script:comment", "cue:comment", "report:reply", "note:comment",
  "org:assign_member", "org:recall_member",
];
