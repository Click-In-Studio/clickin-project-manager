// #227：模版类型运行时读 production_cue_template_type（production 级可配置）。
// 此常量仅作新项目 seed 与 add-cue-template-type.sql 的单一事实源。
export type CueTemplateTypeSeed = {
  key: string;
  abbrHint: string;
  /** 仅信息展示；建表资格走 dept_cue_list_template.can_create */
  creatorRoles: string[];
};

export const DEFAULT_CUE_TEMPLATE_TYPES: CueTemplateTypeSeed[] = [
  { key: "灯光",     abbrHint: "LQ", creatorRoles: ["灯光设计"] },
  { key: "追光",     abbrHint: "FQ", creatorRoles: ["灯光设计"] },
  { key: "音效",     abbrHint: "SQ", creatorRoles: ["音响设计"] },
  { key: "音乐",     abbrHint: "MQ", creatorRoles: ["音响设计", "作曲", "编曲"] },
  { key: "多媒体",   abbrHint: "VQ", creatorRoles: ["多媒体设计"] },
  { key: "舞台机械", abbrHint: "AQ", creatorRoles: ["舞美设计", "舞台监督"] },
  { key: "催场",     abbrHint: "CQ", creatorRoles: ["舞台监督"] },
  { key: "预设",     abbrHint: "PQ", creatorRoles: ["舞台监督"] },
];

// ─── Types ────────────────────────────────────────────────────────────────────

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

/** @deprecated Phase 4: replaced by CueListGrant */
export type CueListPermissionRow = {
  userId: string;
  canEdit: boolean;
};

export type CueListGrant = {
  userId: string;
  userName: string;
  level: "manage" | "edit" | "mount" | "view";
};

export type CueListDeptAccess = {
  deptId: string;
  deptName: string;
};


