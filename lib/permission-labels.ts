type Permission = string;

// 批A 起同时容纳原子键与树节点键（node:<type>/<id>[/<sub>]@<verb>）
export const PERMISSION_LABELS: Partial<Record<Permission, string>> & Record<string, string> = {
  // ── 树节点键（cue 域，批A）──
  "node:cue_list/*/meta@view": "查看Cue表目录",
  "node:cue_list/*/cues@view": "查看Cue表内容",
  "node:cue_list/*/cues/comments@create": "评论Cue",
  "node:cue_list/*@create": "创建Cue表",
  // ── 树节点键（event/task 域，批B）──
  "node:event/*/meta@view": "查看事件目录",
  "node:event/*/details@view": "查看事件详情",
  "node:event/*/followers@create": "关注事件",
  "node:event/*@create": "创建事件",
  "node:event/*/chat@create": "事件群聊",
  "node:event/*/call_sheet@view": "查看他人Call Sheet",
  "node:task/*@view": "查看全部任务",
  "node:task/*@delete": "删除任务",
  // ── 树节点键（report 域，批C）──
  "node:event/*/reports@create": "创建报告",
  "node:report/*/replies@create": "回复报告",
  "node:report/*/replies@edit": "编辑他人报告评论",
  "node:report/*/replies@delete": "删除他人报告评论",
  // 项目管理
  // 通讯录
  // 成员管理
  // 职位管理
  // 部门管理
  // 剧本
  // 章节/段落
  // 角色
  // 剧本标签
  // Cue表
  // 构作
  // 事件（per-event 写操作已迁移至 production_member_grant，原子权限只保留生产级和管理员绕过）
  // Task（技术需求，per-task 写操作已迁移至 production_member_grant）
  // 报告（per-report 写操作已迁移至 production_member_grant，保留生产级和管理员绕过）
  // 数字资产
  // 组织
  // 里程碑
  // 公告
};

export const GROUP_LABELS: Record<string, string> = {
  production: "项目管理",
  contacts: "通讯录",
  members: "成员管理",
  role: "职位管理",
  dept: "部门管理",
  script: "剧本",
  rehearsal_mark: "排练记号",
  scene: "章节/段落",
  character: "角色",
  tag_group: "剧本标签组",
  tag_option: "剧本标签",
  cue_list: "Cue表",
  cue: "Cue",
  dramaturgy: "构作",
  dramaturgy_view: "构作视图",
  event: "事件",
  task: "任务",
  report: "报告",
  asset: "数字资产",
  org: "组织",
  finance: "财务",
  material: "物料台账",
  milestone: "里程碑",
  announcement: "公告",
};

/** 键的分组前缀：原子键取 ':' 前段，节点键取资源类型段 */
export function permissionGroupPrefix(key: string): string {
  if (key.startsWith("node:")) return key.slice(5).split("/")[0] ?? key;
  return key.split(":")[0] ?? key;
}

/** Deduplicated category labels for a list of permission keys */
export function permissionCategories(perms: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of perms) {
    const prefix = permissionGroupPrefix(p);
    const label = GROUP_LABELS[prefix] ?? prefix;
    if (!seen.has(label)) {
      seen.add(label);
      result.push(label);
    }
  }
  return result;
}

// ─── 权限键选择器展示层（管理后台 v3）：type/sub/verb 中文翻译 ───────────────

export const TYPE_LABELS: Record<string, string> = {
  announcement: "公告",
  asset: "数字资产",
  character: "角色（剧本）",
  cue_list: "Cue 表",
  // 部门只有一个实体（production_dept），也只有一个权限类型：dept。
  // org_dept 是 event_department 并表前的遗留名，已于 #327 退役——治理面
  // （建/删/改、成员、POC、权限行）与 notes 面现在同挂 dept 之下。
  dept: "部门",
  dramaturgy: "构作",
  dramaturgy_view: "构作视图",
  event: "事件",
  finance: "财务",
  material: "物料",
  member: "成员",
  milestone: "里程碑",
  note: "备注",
  phase: "阶段",
  producer: "制作人域",
  production: "项目",
  report: "报告",
  role: "角色（职称）",
  scene: "场景",
  script: "剧本",
  script_view: "剧本视图",
  tag_group: "标签组",
  task: "任务",
  user_group: "用户组",
  wiki: "文档",
};

/**
 * 资源类型的分组与展示顺序。
 *
 * 字母序对人没有意义——`dept` / `dramaturgy` / `event` / `finance` 挨在一起，
 * 找「谁批部门的事」得从头扫到尾。这里按「一个人在演出里怎么想事情」分组：
 * 内容 → 排演 → 计划 → 钱与物 → 人与组织 → 文档通告。
 *
 * 未列入的类型（新登记的、或这里忘了补的）由 groupResourceTypes 收进「其他」，
 * 不会因为漏登记就从界面上消失。
 */
export const TYPE_GROUPS: ReadonlyArray<{ label: string; types: readonly string[] }> = [
  { label: "剧本与内容", types: ["script", "script_view", "scene", "character", "dramaturgy", "dramaturgy_view"] },
  { label: "排演与执行", types: ["event", "report", "task", "cue_list", "note"] },
  { label: "计划", types: ["milestone", "phase"] },
  { label: "资产与财务", types: ["asset", "material", "finance"] },
  { label: "人与部门", types: ["member", "dept", "role"] },
  { label: "文档与通告", types: ["wiki", "announcement", "tag_group"] },
  // 治理域排最后：权限键选择器里它们最少用，且 SENSITIVE/ROOT 面本来就写不进模板。
  { label: "项目治理", types: ["production", "producer"] },
];

/** 把一批资源类型按 TYPE_GROUPS 分组排好；组内按 TYPE_GROUPS 的次序，不按字母。 */
export function groupResourceTypes(
  types: readonly string[],
): { label: string; types: string[] }[] {
  const remaining = new Set(types);
  const out: { label: string; types: string[] }[] = [];
  for (const group of TYPE_GROUPS) {
    const hit = group.types.filter((t) => remaining.has(t));
    hit.forEach((t) => remaining.delete(t));
    if (hit.length > 0) out.push({ label: group.label, types: hit });
  }
  if (remaining.size > 0) {
    out.push({ label: "其他", types: [...remaining].sort() });
  }
  return out;
}

export const SUB_LABELS: Record<string, string> = {
  "*": "（主面）",
  meta: "基本信息",
  "meta/name": "名称",
  "meta/avatar": "头像",
  "meta/description": "简介",
  "meta/type": "类型",
  "meta/language": "语言",
  grants: "授权管理",
  publication: "发布可见",
  assignees: "指派",
  imports: "导入",
  mounts: "挂载",
  archival: "归档",
  restores: "恢复",
  owner: "所有权",
  config: "配置",
  integrations: "集成",
  asset_review: "资产审查",
  overrides: "人事裁决",
  roles: "角色指派",
  members: "成员",
  poc: "POC",
  budget: "预算科目",
  expenses: "支出",
  contact: "联系方式",
  cues: "Cue 行",
  "cues/comments": "Cue 评论",
  comments: "评论",
  blocks: "文本块",
  details: "详情",
  call_sheet: "通告",
  chat: "群聊",
  followers: "关注",
  reports: "报告",
  tasks: "任务",
  notes: "备注",
  replies: "回复",
  shares: "分享",
  file: "文件",
  biography: "人物小传",
  gender: "性别",
  role_type: "角色类型",
  synopsis: "梗概",
  action_line: "行动线",
  music: "音乐",
  stage_notes: "舞台呈现",
};

export const VERB_LABELS: Record<string, string> = {
  view: "查看",
  create: "创建",
  edit: "编辑",
  delete: "删除",
  "*": "全部动词",
};

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ? `${TYPE_LABELS[type]}（${type}）` : type;
}

export function subLabel(sub: string): string {
  return SUB_LABELS[sub] ? `${SUB_LABELS[sub]}（${sub}）` : sub;
}

export function verbLabel(verb: string): string {
  return VERB_LABELS[verb] ? `${VERB_LABELS[verb]}（${verb}）` : verb;
}
