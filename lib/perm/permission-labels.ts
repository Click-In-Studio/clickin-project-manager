/**
 * 权限键 → 人话（#541）。
 *
 * 面向成员的三个消费点（激活弹窗 / 403 页 / 申请弹窗）统一走 permissionLabel()。
 * 键是规则串 `node:<type>/<id>[/<sub>]@<verb>`，标签也按规则**拼**：
 * `动词 + 资源名 + 子面`（「查看 + 章节/段落 + 梗概」）。三张小词表
 * （GROUP_LABELS / SUB_LABELS / VERB_LABELS）就是全部真相，新加一枚键只要
 * 三段都已登记，不用再来这里补一行。只有拼出来不像人话的键才进 PERMISSION_LABELS
 * 手写表（「关注事件」而不是「创建事件关注」）。
 *
 * 棘轮 tests/perm/permission-labels.test.ts：模板与激活面目录里的每枚键必须
 * 三段齐全（unlabelledParts 为空），缺一段就红。
 */

/** 手写覆盖：拼接读起来别扭的键才登记。同风格：动宾短语。 */
export const PERMISSION_LABELS: Record<string, string> = {
  // ── 制作人通配五行（lib/production/templates/shared.ts PRODUCER_KEYS）──
  "node:*/*@*": "全部资源的全部操作",
  "node:*/*/assignees@*": "全部资源的指派",
  "node:*/*/grants@*": "全部资源的授权管理",
  "node:*/*/imports@create": "全部资源的导入",
  "node:*/*/publication@*": "全部资源的发布与撤回",
  // ── 剧本 ──
  "node:script/*/blocks@view": "查看剧本",
  "node:script/*/blocks@edit": "编辑剧本",
  "node:script/*/blocks@create": "插入剧本文本块",
  "node:script/*/comments@create": "评论剧本",
  "node:script/*/imports@create": "导入剧本",
  "node:script/*/mounts@create": "挂载资产到剧本",
  "node:dramaturgy/*/imports@create": "导入构作",
  // ── 章节/段落 / 角色 ──
  "node:scene/*/mounts@create": "挂载资产到章节/段落",
  "node:character/*/members@view": "查看角色扮演者",
  "node:character/*/role_type@view": "查看角色类型",
  // ── Cue ──
  "node:cue_list/*/meta@view": "查看Cue表目录",
  "node:cue_list/*/cues@view": "查看Cue表内容",
  "node:cue_list/*/cues/comments@create": "评论Cue",
  // ── 事件 / 任务 / 报告 ──
  "node:event/*/meta@view": "查看事件目录",
  "node:event/*/followers@create": "关注事件",
  "node:event/*/chat@create": "事件群聊",
  "node:event/*/call_sheet@view": "查看他人Call Sheet",
  "node:event/*/publication@view": "查看未发布的事件",
  "node:event/*/publication@create": "发布事件",
  "node:event/*/publication@delete": "撤回已发布的事件",
  "node:task/*@view": "查看全部任务",
  "node:report/*/replies@create": "回复报告",
  "node:report/*/replies@edit": "编辑他人报告评论",
  "node:report/*/replies@delete": "删除他人报告评论",
  // ── 数字资产 / 财务 ──
  "node:asset/*@create": "上传数字资产",
  "node:asset/*/file@create": "上传数字资产新版本",
  "node:asset/*/shares@create": "分享数字资产",
  "node:finance/*/expenses@create": "登记支出",
  // ── 项目 / 部门 ──
  "node:production/*/mounts@view": "查看项目挂载的资产",
  "node:dept/*/notes@create": "添加部门备注",
  // ── AI 用量（#383）──
  "node:ai/*/usage@view": "查看项目AI用量",
  "node:ai/*/usage/members@view": "查看成员AI用量明细",
};

/** 面向成员的资源名（弹窗分组标题、拼接标签的主语）。管理后台选择器另有带括注消歧的 TYPE_LABELS。 */
export const GROUP_LABELS: Record<string, string> = {
  "*": "全部资源",
  ai: "AI 用量",
  announcement: "公告",
  asset: "数字资产",
  character: "角色",
  cue_list: "Cue表",
  dept: "部门",
  dramaturgy: "构作",
  dramaturgy_view: "构作视图",
  event: "事件",
  finance: "财务",
  material: "物料台账",
  member: "成员",
  milestone: "里程碑",
  note: "备注",
  phase: "阶段",
  producer: "制作人域",
  production: "项目",
  report: "报告",
  role: "职位",
  scene: "章节/段落",
  script: "剧本",
  script_view: "剧本视图",
  tag_group: "剧本标签组",
  task: "任务",
  user_group: "用户组",
  wiki: "文档",
};

/**
 * 审批申请的伪级别 → 人话（#582）。
 *
 * 申请单上的 permission_level 有两种形：sub='*' 时是伪级别（cue_list 的 manage、
 * event 的 publish……展开表见 lib/perm/resource-grant-db.ts 的 *_LEVEL_ROW_SETS），
 * 带具体 sub 时就是动词（VERB_LABELS）。飞书通知正文、资源申请页列表、两个申请
 * 表单的下拉都从这一张表取名——以前各抄一份，新开放一种级别就有一处漏改。
 *
 * 棘轮 tests/perm/permission-labels.test.ts：每张 *_LEVEL_ROW_SETS 的键都必须在此登记。
 */
export const LEVEL_LABELS: Record<string, string> = {
  view:           "查看",
  mount:          "挂载",
  edit:           "编辑",
  assign:         "指派",
  manage:         "管理",
  publish:        "发布",
  edit_published: "修改已发布",
  revoke:         "撤销",
};

/**
 * 资源类型名（申请单主语）。查不到不裸吐 key：通知正文里「所有 dramaturgy_view 的
 * 编辑权限」审批人看不懂，兜底同 permissionLabel 的风格把 key 放进括注。
 */
export function resourceTypeLabel(type: string | null | undefined): string {
  if (!type) return "资源";
  return GROUP_LABELS[type] ?? `资源（${type}）`;
}

/**
 * 权限级别名：先查伪级别表，再查动词表（带 sub 的节点键申请 level 位就是动词）。
 * 两张表都没有时用「」框住原样嵌进句子（「所有剧本的「foo」权限」），与
 * resourceTypeLabel 一样不让裸 key 混进中文正文。
 */
export function permissionLevelLabel(level: string | null | undefined): string {
  if (!level) return "访问";
  return LEVEL_LABELS[level] ?? VERB_LABELS[level] ?? `「${level}」`;
}

/** 键的分组前缀：原子键取 ':' 前段，节点键取资源类型段 */
export function permissionGroupPrefix(key: string): string {
  if (key.startsWith("node:")) return key.slice(5).split("/")[0] ?? key;
  return key.split(":")[0] ?? key;
}

/** 分组标题：查不到资源名时给原样前缀（不会再是裸键）。 */
export function permissionGroupLabel(key: string): string {
  const prefix = permissionGroupPrefix(key);
  return GROUP_LABELS[prefix] ?? prefix;
}

/** Deduplicated category labels for a list of permission keys */
export function permissionCategories(perms: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of perms) {
    const label = permissionGroupLabel(p);
    if (!seen.has(label)) {
      seen.add(label);
      result.push(label);
    }
  }
  return result;
}

// 比 grant-template 的 parseNodeKey 宽：type / verb 位允许通配（区间键语法），
// 动词不限闭集——这里只做展示，不做判定，遇到未知动词照样拼出人话。
const LABEL_KEY_RE = /^node:([a-z_*]+)\/([^/@]+)(?:\/([^@]+))?@([a-z_*]+)$/;

type LabelParts = { type: string; id: string; sub: string; verb: string };

function splitLabelKey(key: string): LabelParts | null {
  const m = LABEL_KEY_RE.exec(key);
  if (!m) return null;
  return { type: m[1], id: m[2], sub: m[3] ?? "*", verb: m[4] };
}

/**
 * 这一段拼接时要不要带子面词。null = 不带（主面 `*`；`meta@view` 是资源的门票，
 * 三态模型下说成「查看 X」，不说「查看 X 基本信息」）。
 * permissionLabel 与 unlabelledParts 共用，保证棘轮和渲染走同一条规则。
 */
function subToLabel(p: LabelParts): string | null {
  if (p.sub === "*") return null;
  if (p.sub === "meta" && p.verb === "view") return null;
  return p.sub;
}

/**
 * 把权限键翻成人话。手写表 → 三段拼接 → 兜底。
 *
 * 拼接规则：
 *   - 子面词按 subToLabel（门票 / 主面不带）；
 *   - 实例级 id 说成「此」：「编辑此文档」；
 *   - 通配 verb：「X（全部操作）」——「全部操作X」不像话，词序有意不对称。
 * 兜底：某段词表里没有时，那一段原样嵌进人话（「查看剧本（foo）」），
 * 决不裸吐整枚键；只有连键形都不对（原子键）才原样返回。
 */
export function permissionLabel(key: string): string {
  const hand = PERMISSION_LABELS[key];
  if (hand) return hand;
  const p = splitLabelKey(key);
  if (!p) return key;
  const typeText = GROUP_LABELS[p.type] ?? p.type;
  const subject = `${p.id === "*" ? "" : "此"}${typeText}`;
  const sub = subToLabel(p);
  const subText = sub === null ? "" : (SUB_LABELS[sub] ?? `（${sub}）`);
  if (p.verb === "*") return `${subject}${subText}（全部操作）`;
  const verbText = VERB_LABELS[p.verb] ?? p.verb;
  return `${verbText}${subject}${subText}`;
}

/**
 * 棘轮用：这枚键拼人话时缺哪些词表条目。手写表命中 → 空；
 * 否则逐段查 GROUP_LABELS / SUB_LABELS / VERB_LABELS，返回缺的条目名
 * （如 "SUB_LABELS.categories"）。原子键（非 node 键形）也算缺：它没有任何人话来源。
 */
export function unlabelledParts(key: string): string[] {
  if (PERMISSION_LABELS[key]) return [];
  const p = splitLabelKey(key);
  if (!p) return [`PERMISSION_LABELS.${key}`];
  const missing: string[] = [];
  if (!GROUP_LABELS[p.type]) missing.push(`GROUP_LABELS.${p.type}`);
  const sub = subToLabel(p);
  if (sub !== null && !SUB_LABELS[sub]) missing.push(`SUB_LABELS.${sub}`);
  if (!VERB_LABELS[p.verb]) missing.push(`VERB_LABELS.${p.verb}`);
  return missing;
}

// ─── 权限键选择器展示层（管理后台 v3）：type/sub/verb 中文翻译 ───────────────

export const TYPE_LABELS: Record<string, string> = {
  // AI 用量账本（#383）：只有 view 一个动词——「改额度」不是权限键能表达的东西
  // （那是兑换码/管理员发放）。默认不进任何角色模版：额度是 owner 的钱，
  // 要给制作人看由 owner 在权限中心显式发。
  ai: "AI 用量",
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
  { label: "AI", types: ["ai"] },
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
  "meta/expected_duration": "预计时长",
  usage: "AI 用量",
  "usage/members": "AI 用量（按成员）",
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
  categories: "预算科目",
  expenses: "支出",
  contact: "联系方式",
  cues: "Cue 行",
  "cues/comments": "Cue 评论",
  comments: "评论",
  blocks: "文本块",
  "blocks/character": "文本块角色归属",
  "blocks/position": "文本块顺序",
  "blocks/tags": "文本块标签",
  "blocks/type": "文本块类型",
  rehearsal_marks: "排练标记",
  "rehearsal_marks/position": "排练标记位置",
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
  options: "选项",
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
  "*": "全部操作",
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
