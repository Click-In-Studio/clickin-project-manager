// Role names match the system's ROLE_GROUPS exactly.
// (e.g. "灯光设计助理", not "助理灯光设计")

export type CueListTemplate = {
  key: string;
  label: string;
  creatorRoles: string[];
  defaultEditRoles: string[];
};

export const CUE_LIST_TEMPLATES: CueListTemplate[] = [
  {
    key: "灯光",
    label: "灯光",
    creatorRoles: ["灯光设计"],
    defaultEditRoles: ["灯光设计", "灯光设计助理"],
  },
  {
    key: "追光",
    label: "追光",
    creatorRoles: ["灯光设计"],
    defaultEditRoles: ["灯光设计", "灯光设计助理"],
  },
  {
    key: "音效",
    label: "音效",
    creatorRoles: ["音响设计"],
    defaultEditRoles: ["音响设计", "音响设计助理"],
  },
  {
    key: "音乐",
    label: "音乐",
    creatorRoles: ["音响设计", "作曲", "编曲"],
    defaultEditRoles: ["音响设计", "音响设计助理", "作曲", "作曲助理", "编曲"],
  },
  {
    key: "多媒体",
    label: "多媒体",
    creatorRoles: ["多媒体设计"],
    defaultEditRoles: ["多媒体设计", "多媒体设计助理"],
  },
  {
    key: "舞台机械",
    label: "舞台机械",
    creatorRoles: ["舞美设计", "舞台监督"],
    defaultEditRoles: ["舞美设计", "舞美设计助理", "舞台监督", "助理舞台监督"],
  },
  {
    key: "催场",
    label: "催场",
    creatorRoles: ["舞台监督"],
    defaultEditRoles: ["舞台监督", "助理舞台监督"],
  },
  {
    key: "预设",
    label: "预设",
    creatorRoles: ["舞台监督"],
    defaultEditRoles: ["舞台监督", "助理舞台监督", "舞美设计", "舞美设计助理"],
  },
];

// Roles that can create any cue list (template-specific or custom)
export const CUE_CREATE_ROLES = new Set([
  "灯光设计",
  "音响设计",
  "多媒体设计",
  "服化设计",
  "舞美设计",
  "舞台监督",
  "导演",
  "制作人",
  "作曲",
  "编曲",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export const TEMPLATE_ABBR_HINTS: Record<string, string> = {
  "灯光": "LQ",
  "追光": "FQ",
  "音效": "SQ",
  "音乐": "MQ",
  "多媒体": "VQ",
  "舞台机械": "AQ",
  "催场": "CQ",
  "预设": "PQ",
};

export type CueList = {
  id: string;
  productionId: string;
  name: string;
  notes: string;
  abbr: string | null;
  template: string | null;
  defaultEditRoles: string[];
  createdBy: string;
  createdByName: string;
  createdAt: string;
};

export type CueListPermissionRow = {
  userId: string;
  canEdit: boolean;
};

// ─── Permission helpers ───────────────────────────────────────────────────────

export function canEditCueList(
  userId: string,
  userRoles: string[] | null,
  isAdmin: boolean,
  cueList: Pick<CueList, "createdBy" | "defaultEditRoles">,
  permissions: CueListPermissionRow[],
): boolean {
  if (isAdmin) return true;
  if (!userRoles) return false;
  if (cueList.createdBy === userId) return true;
  if (userRoles.includes("制作人")) return true;
  const override = permissions.find((p) => p.userId === userId);
  if (override !== undefined) return override.canEdit;
  return userRoles.some((r) => cueList.defaultEditRoles.includes(r));
}

export function canManageCueListPermissions(
  userId: string,
  userRoles: string[] | null,
  isAdmin: boolean,
  cueList: Pick<CueList, "createdBy">,
): boolean {
  if (isAdmin) return true;
  if (!userRoles) return false;
  return cueList.createdBy === userId || userRoles.includes("制作人");
}

export function canCreateCueList(
  userRoles: string[] | null,
  isAdmin: boolean,
): boolean {
  if (isAdmin) return true;
  if (!userRoles) return false;
  return userRoles.some((r) => CUE_CREATE_ROLES.has(r));
}

/** Returns templates this user is allowed to create, based on their roles. */
export function availableTemplatesForRoles(userRoles: string[], isAdmin: boolean): CueListTemplate[] {
  if (isAdmin) return CUE_LIST_TEMPLATES;
  return CUE_LIST_TEMPLATES.filter((t) =>
    t.creatorRoles.some((r) => userRoles.includes(r))
  );
}
