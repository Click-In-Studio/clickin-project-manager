export type CueListTemplate = {
  key: string;
  label: string;
  /** Role names that historically could create this type; informational only (Phase 4+: use dept.allowed_cue_types). */
  creatorRoles: string[];
};

export const CUE_LIST_TEMPLATES: CueListTemplate[] = [
  { key: "灯光",   label: "灯光",   creatorRoles: ["灯光设计"] },
  { key: "追光",   label: "追光",   creatorRoles: ["灯光设计"] },
  { key: "音效",   label: "音效",   creatorRoles: ["音响设计"] },
  { key: "音乐",   label: "音乐",   creatorRoles: ["音响设计", "作曲", "编曲"] },
  { key: "多媒体", label: "多媒体", creatorRoles: ["多媒体设计"] },
  { key: "舞台机械", label: "舞台机械", creatorRoles: ["舞美设计", "舞台监督"] },
  { key: "催场",   label: "催场",   creatorRoles: ["舞台监督"] },
  { key: "预设",   label: "预设",   creatorRoles: ["舞台监督"] },
];

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
  createdBy: string;
  createdByName: string;
  createdAt: string;
};

export type CueListPermissionRow = {
  userId: string;
  canEdit: boolean;
};

/** Returns templates whose creatorRoles match the user's production roles (UI filter, not a gate). */
export function availableTemplatesForRoles(memberRoles: string[]): CueListTemplate[] {
  return CUE_LIST_TEMPLATES.filter((t) =>
    t.creatorRoles.some((r) => memberRoles.includes(r))
  );
}
