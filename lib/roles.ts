export type RoleGroup = { label: string; roles: string[] };

export const ROLE_GROUPS: RoleGroup[] = [
  { label: "boss",     roles: ["制作人", "制作助理"] },
  { label: "创作组",   roles: ["编剧", "编剧助理", "戏剧构作", "导演", "副导演", "导演助理", "作曲", "作曲助理", "编曲"] },
  { label: "设计组",   roles: ["舞美设计", "舞美设计助理", "灯光设计", "灯光设计助理", "多媒体设计", "多媒体设计助理", "服化设计", "服化设计助理", "音响设计", "音响设计助理"] },
  { label: "执行组",   roles: ["技术导演", "灯光编程", "音响执行"] },
  { label: "舞台监督", roles: ["舞台监督", "助理舞台监督"] },
  { label: "宣发/外围", roles: ["新媒体", "侧写"] },
  { label: "演员",     roles: ["演员", "群演"] },
  { label: "特殊岗位", roles: ["肢体指导", "编舞"] },
];

export const ALL_ROLES = new Set(ROLE_GROUPS.flatMap((g) => g.roles));

// ─── Permissions ──────────────────────────────────────────────────────────────

export type Permission =
  | "manage_permissions"    // 制作人 (+ superadmin)
  | "import_contacts"       // 制作人, 制作助理 (+ superadmin)
  | "view_contacts"         // any member
  | "script:read"           // any member
  | "script:comment"        // any member
  | "script:rehearsal_mark" // 编剧, 制作人, 戏剧构作, 作曲, 作曲助理, 编曲
  | "script:metadata"       // 编剧, 制作人, 戏剧构作
  | "script:edit";          // 编剧, 制作人

export const PERMISSION_LABELS: Record<Permission, string> = {
  manage_permissions:    "管理成员权限",
  import_contacts:       "导入/更新人员",
  view_contacts:         "查看通讯录",
  "script:read":         "查看剧本",
  "script:comment":      "剧本评论",
  "script:rehearsal_mark": "排练记号",
  "script:metadata":     "角色/章节信息",
  "script:edit":         "剧本文本编辑",
};

export const PERMISSION_GROUPS: { label: string; perms: Permission[] }[] = [
  { label: "通讯录", perms: ["view_contacts", "import_contacts"] },
  { label: "剧本",   perms: ["script:read", "script:comment", "script:rehearsal_mark", "script:metadata", "script:edit"] },
  { label: "管理",   perms: ["manage_permissions"] },
];

type PermConfig = {
  roles: Set<string> | null; // null = any member
  adminBypass: boolean;      // false = superadmin must also hold a qualifying role
};

const ROLE_PERMISSIONS: Record<Permission, PermConfig> = {
  manage_permissions:      { roles: new Set(["制作人"]),                                                            adminBypass: true  },
  import_contacts:         { roles: new Set(["制作人", "制作助理"]),                                                adminBypass: true  },
  view_contacts:           { roles: null,                                                                           adminBypass: true  },
  "script:read":           { roles: null,                                                                           adminBypass: true  },
  "script:comment":        { roles: null,                                                                           adminBypass: true  },
  "script:rehearsal_mark": { roles: new Set(["编剧", "制作人", "戏剧构作", "作曲", "作曲助理", "编曲"]),             adminBypass: false },
  "script:metadata":       { roles: new Set(["编剧", "制作人", "戏剧构作"]),                                        adminBypass: false },
  "script:edit":           { roles: new Set(["编剧", "制作人"]),                                                    adminBypass: false },
};

export type PermissionOverrides = Map<Permission, boolean>;

/**
 * @param memberRoles  Roles in this production, or null if the user is not a member.
 * @param overrides    Per-member explicit grants/denies (take absolute precedence).
 */
export function hasPermission(
  perm: Permission,
  isAdmin: boolean,
  memberRoles: string[] | null,
  overrides?: PermissionOverrides,
): boolean {
  if (overrides?.has(perm)) return overrides.get(perm)!;
  const { roles, adminBypass } = ROLE_PERMISSIONS[perm];
  if (isAdmin && adminBypass) return true;
  if (memberRoles === null) return false;
  if (roles === null) return true;
  return memberRoles.some((r) => roles.has(r));
}

/** Role-derived value without any overrides applied — used to show the "default" state in UI. */
export function roleBasedPermission(
  perm: Permission,
  isAdmin: boolean,
  memberRoles: string[] | null,
): boolean {
  return hasPermission(perm, isAdmin, memberRoles);
}
