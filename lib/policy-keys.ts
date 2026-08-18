/**
 * 策略键词汇表（#236 基建）——配置中心的可配项 = 本表；策略模版存的就是本表的一组值。
 * 两者是同一张键表的两个面，不分别设计，也就不会分叉。
 *
 * 设计见 MindWeave《权限系统-不变量与策略汇总》§2.0 / §5 / §6。三条纪律定在这里：
 *
 * **形状**（§2.0）：
 *   A 发行开关   `<type>.<actor>:<sub>@<verb>`  写点读，决定发不发这一行；不追溯
 *   C 推导参数   `policy.<name>`                判定端读，作为无行推导规则的参数；自动追溯
 *   L 生命周期   `policy.<name>`                结构变更的副作用点读；只影响此后的边变更
 *
 * **铁律**：策略开关只能决定发不发一行（A），或作为无行推导规则的参数（C/L）。
 * **绝不能让开关否决一条已经存在的行，也不能改变一行的含义。**
 *
 * **形状 A 只作用于自动授权定式（C/R/Z 系）的写点**，不作用于审批发行 / 直接授权 /
 * 自确认——人的显式决定压过默认策略，否则会出现「审批已批准但发不出行」的死状态。
 *
 * **受益方只能是动作角色**（creator / uploader / participant / assignee / poc /
 * stage_manager），任何时候不许出现具体 role name 或 dept id——这是策略模版与角色模版、
 * 部门模版正交、建项目时可自由组合的前提，破了当场碎。ACTION_ROLES 是白名单，
 * 有棘轮盯着。
 *
 * **默认值规律**（§2.0 推论三，不必逐键辩论）：创建者的对内建设性动作默认开；
 * 对外发布与破坏性动作默认关。
 *
 * 不在本表的东西同样重要：M-14 创建者底座、M-15 全部五子句、四保留段、二保留类型、
 * TTL 全覆盖、成员门 M-13、SENSITIVE/ROOT 阶梯、挂载双门、六步链结构——**不可配**，
 * 配置中心不渲染、模版不收录（§5.5）。
 */
import type { GrantVerb } from "./grant-check";

export type PolicyShape = "A" | "C" | "L";

/** 形状 A 的受益方白名单：**动作角色**，不是 role name / dept id（§2.0 推论二）。 */
export const ACTION_ROLES: readonly string[] = [
  "creator", "uploader", "participant", "assignee", "poc", "dept_poc", "stage_manager",
];

export const POLICY_ON = "on";
export const POLICY_OFF = "off";
const ON_OFF: readonly string[] = [POLICY_ON, POLICY_OFF];

/** 形状 A 键裁的那一行。type 由键前缀推出，不重复存。 */
export type PolicyRow = { sub: string; verb: GrantVerb };

export type PolicyKeyDef = {
  key: string;
  shape: PolicyShape;
  /** 合法取值白名单——服务端据此校验，SQL 侧不设 CHECK（加键零 migration）。 */
  values: readonly string[];
  defaultValue: string;
  /** 人话标题，配置中心高级模式逐键展示用。 */
  label: string;
  /** 说明文案：**写清后果**，不要复述键名。 */
  help: string;
  /** 形状 A 专用：资源类型 + 动作角色 + 被裁的行。 */
  a?: { type: string; actor: string; row: PolicyRow };
};

// ─── 形状 A ───────────────────────────────────────────────────────────────────

function a(
  type: string, actor: string, sub: string, verb: GrantVerb,
  defaultValue: string, label: string, help: string,
): PolicyKeyDef {
  return {
    key: `${type}.${actor}:${sub}@${verb}`,
    shape: "A", values: ON_OFF, defaultValue, label, help,
    a: { type, actor, row: { sub, verb } },
  };
}

/** 批量：同一 (type, actor) 下多个动词共用一套文案。 */
function aMany(
  type: string, actor: string, subs: readonly [string, GrantVerb][],
  defaultValue: string, label: (sub: string, verb: GrantVerb) => string, help: string,
): PolicyKeyDef[] {
  return subs.map(([sub, verb]) => a(type, actor, sub, verb, defaultValue, label(sub, verb), help));
}

const EVENT_CREATOR: PolicyKeyDef[] = [
  ...aMany("event", "creator", [["assignees", "create"], ["assignees", "delete"]], POLICY_ON,
    () => "事件创建者可增删参会名单",
    "关掉后 organizer 只能填内容，名单由跟组舞监定。"),
  a("event", "creator", "call_sheet", "edit", POLICY_ON,
    "事件创建者可排 call time",
    "关掉后排 call 权仅归跟组舞监（原 organizer_can_set_call_time）。"),
  a("event", "creator", "publication", "create", POLICY_OFF,
    "事件创建者可发布自己创建的事件",
    "默认关：发布归舞监 role。打开后 organizer 无需舞监即可让全组看到该事件"
    + "（原 organizer_can_publish）。**注意这只管创建者自己的事件**，"
    + "「谁能发布任意事件」在角色模版里，不在本表（§6.2 语义问题不得跨模版）。"),
  ...aMany("event", "creator", [["publication", "edit"], ["publication", "delete"]], POLICY_ON,
    (_s, v) => v === "edit" ? "事件创建者可修订已发布的事件" : "事件创建者可撤回已发布的事件",
    "关掉后已发布事件的修订/撤回只能由舞监或制作人操作。"),
  ...aMany("event", "creator", [["tasks", "create"], ["tasks", "delete"]], POLICY_ON,
    (_s, v) => v === "create" ? "事件创建者可把任务挂到自己的事件上" : "事件创建者可把任务从自己的事件上摘下来",
    "**这是边键，不是删除权**（M-15）：摘边只解绑，任务本体还在，由部门继续持有。"),
  ...aMany("event", "creator", [["reports", "create"], ["reports", "delete"]], POLICY_ON,
    (_s, v) => v === "create" ? "事件创建者可给自己的事件加报告" : "事件创建者可把报告从自己的事件上撤下来",
    "**这是边键，不是删除权**（M-15）：撤边不删文档，作者仍可访问（定式 C-7 会补发行）。"),
  a("event", "creator", "grants", "edit", POLICY_ON,
    "事件创建者可把自己事件的权限转授他人",
    "关掉后转授只能由归属部门的 POC 或制作人做。"
    + "（该事件若无任何归属部门，M-14 存在性子句会强制保留，本开关对它无效。）"),
  a("event", "creator", "*", "delete", POLICY_OFF,
    "事件创建者可删除自己创建的事件",
    "默认关：事件有对外承诺性质，他人已按它安排行程，删除应走制作人。"
    + "松的剧组可打开——建错了自己删。",
  ),
];

const EVENT_OTHERS: PolicyKeyDef[] = [
  ...aMany("event", "participant", [["meta", "view"], ["details", "view"]], POLICY_ON,
    () => "参会者可见事件的时间地点",
    "定式 R-1。关掉后被拉进事件的人看不到事件本身，只能靠通知——基本不该关。"),
  a("event", "dept_poc", "reports", "view", POLICY_ON,
    "参与部门的 POC 可见该事件的报告（含未发布）",
    "定式 R-2。POC 无需在场即可提前看到 draft 报告。"),
  ...aMany("event", "assignee", [["meta", "view"], ["details", "view"], ["publication", "view"]], POLICY_ON,
    () => "被指派任务的人可见所属事件",
    "定式 R-4。被叫来干活必须看到时间地点，关掉会让人不知道去哪——基本不该关。"),
  ...aMany("event", "stage_manager",
    [["meta", "view"], ["details", "view"], ["publication", "view"],
     ["call_sheet", "view"], ["call_sheet", "edit"], ["tasks", "view"],
     ["reports", "view"], ["reports", "create"], ["reports", "edit"], ["reports", "delete"]],
    POLICY_ON,
    (sub, verb) => `跟组舞监对事件的 ${sub}@${verb}`,
    "定式 R-3。跟组舞监十行集，无需发布即生效。"),
];

const REPORT_CREATOR: PolicyKeyDef[] = [
  ...aMany("report", "creator", [["notes", "create"], ["notes", "delete"]], POLICY_ON,
    () => "报告创建者可增删报告下的 note",
    "关掉后 note 的增删归部门 POC。"),
  ...aMany("report", "creator",
    [["publication", "create"], ["publication", "edit"], ["publication", "delete"]], POLICY_ON,
    (_s, v) => v === "create" ? "报告创建者可发布报告"
      : v === "edit" ? "报告创建者可修订已发布的报告" : "报告创建者可撤回已发布的报告",
    "关掉后发布面归舞监或制作人。"),
  a("report", "creator", "grants", "edit", POLICY_ON,
    "报告创建者可把报告权限转授他人",
    "关掉后转授归归属部门的 POC 或制作人。"),
  a("report", "creator", "*", "delete", POLICY_OFF,
    "报告创建者可把报告从事件上撤下来",
    "**撤的是边，不是文档**（M-15）：wiki 本体仍在、作者仍可访问。"
    + "默认关：报告是留档物，撤下应由舞监决定。",
  ),
];

const TASK_DEPT_POC: PolicyKeyDef[] = [
  a("task", "dept_poc", "*", "edit", POLICY_ON,
    "关联部门的 POC 可编辑任务内容",
    "关掉后 POC 只能推进状态、不能改内容。"),
  a("task", "dept_poc", "assignees", "edit", POLICY_ON,
    "关联部门的 POC 可指派任务",
    "定式 C-4 + 指派面独立定谳：任务分配归部门，不归 organizer。关掉等于本部门没人能派活。"),
  a("task", "dept_poc", "grants", "edit", POLICY_ON,
    "关联部门的 POC 可转授任务权限",
    "关掉后转授归制作人。"),
  a("task", "dept_poc", "*", "delete", POLICY_OFF,
    "部门收到的任务，本部门 POC 可以删",
    "默认关＝任务归**派发方**所有，部门是执行方。打开＝部门**收到即拥有**，"
    + "别人不得替它决定生死。**本键与 policy.orphan_task_disposition 耦合**"
    + "（§5.3）：两者必须由同一道题设定，配不出「部门拥有 ＋ 失去锚点自动清理」"
    + "这种自相矛盾的组合。",
  ),
];

const ASSET_UPLOADER: PolicyKeyDef[] = [
  a("asset", "uploader", "*", "delete", POLICY_ON,
    "上传者可删除自己上传的素材",
    "关掉后删除归制作人。"),
  ...aMany("asset", "uploader", [["publication", "create"], ["publication", "delete"]], POLICY_ON,
    (_s, v) => v === "create" ? "上传者可把素材挂到项目内其他资源上" : "上传者可解除自己素材的挂载",
    "挂载是**项目内**可见性让渡，不是对外分享。"),
  a("asset", "uploader", "shares", "create", POLICY_ON,
    "上传者可为自己的素材生成对外分享链接",
    "**这是资格，不是开关**——项目层是否允许对外分享由 policy.share_token_enabled 决定，"
    + "两者串联。该项目关掉出口后，本键为「开」也发不出链接。",
  ),
];

const WIKI_CUE_DEPT: PolicyKeyDef[] = [
  a("wiki", "creator", "*", "delete", POLICY_ON,
    "文档创建者可删除自己创建的文档",
    "关掉后删除归制作人。注意独立文档没有归属部门兜底。"),
  ...aMany("cue_list", "creator", [["cues", "create"], ["cues", "delete"]], POLICY_ON,
    () => "Cue 表创建者可增删本表的 cue",
    "关掉后建表人只能改表头、不能编条目——基本不该关。"),
  a("cue_list", "creator", "*", "delete", POLICY_ON,
    "Cue 表创建者可删除自己创建的表",
    "关掉后删除归声明该模版的部门 POC 或制作人。"),
  a("cue_list", "creator", "grants", "edit", POLICY_ON,
    "Cue 表创建者可转授本表权限",
    "关掉后转授归归属部门的 POC。"),
  ...aMany("dept", "poc", [["notes", "create"], ["notes", "edit"], ["notes", "delete"]], POLICY_ON,
    () => "部门 POC 可管理本部门的 note",
    "定式 R-6（production 级，不限单个事件）。这是唯一会随卸任显式撤销的定式。"),
];

// ─── 形状 C：推导参数（判定端读，自动追溯）─────────────────────────────────────

const SHAPE_C: PolicyKeyDef[] = [
  {
    key: "policy.share_token_enabled", shape: "C", values: ON_OFF, defaultValue: POLICY_OFF,
    label: "允许生成对外分享链接",
    help: "**全系统唯一的出口**——令牌的受众不在项目成员里，一行 grant 都不产生，"
      + "所以 TTL 全覆盖、退出项目全撤、POC 卸任撤销**一条都覆盖不到它**。"
      + "发令牌与令牌兑现两处同读本开关，故关掉＝停发新链接 ＋ 已发链接同时失效。"
      + "默认关，宽松剧组显式打开。",
  },
  {
    key: "policy.asset_public_enabled", shape: "C", values: ON_OFF, defaultValue: POLICY_ON,
    label: "允许素材免挂载对全组可见",
    help: "asset.is_public 只**免除挂载要求**，可见仍需能力票（meta|file@view），"
      + "受众上限是本项目持票成员——**不是对外公开**。",
  },
  {
    key: "policy.wiki_public_enabled", shape: "C", values: ON_OFF, defaultValue: POLICY_ON,
    label: "允许文档设为全项目公开",
    help: "wiki.is_public 是**无条件全员可见**（绕过所有 grant），比素材那个宽一档，"
      + "但受众同样在项目内。",
  },
  {
    key: "policy.note_create_requires_poc", shape: "C", values: ON_OFF, defaultValue: POLICY_OFF,
    label: "给部门提 note 必须经该部门 POC",
    help: "打开后普通成员不能直接给部门提 note，须由 POC 代提。",
  },
  {
    key: "policy.organizer_moderates_notes", shape: "C", values: ON_OFF, defaultValue: POLICY_ON,
    label: "事件编辑者可管理任意部门的 note",
    help: "定式 V-3：持 event details@edit 的人可发/管任意部门 note。"
      + "关掉后各部门的 note 只由本部门 POC 管。",
  },
  {
    key: "policy.task_dept_visibility", shape: "C", values: ON_OFF, defaultValue: POLICY_ON,
    label: "已确认的任务对关联部门全员可见",
    help: "关掉后只有指派到的人和 POC 能看见——部门其他人无法自行了解本部门在做什么。",
  },
];

// ─── 形状 L：生命周期规则（边变更的副作用，不碰权限）─────────────────────────────

export const ORPHAN_TASK_KEEP = "keep";
export const ORPHAN_TASK_MIDDLE = "delete_untouched";
export const ORPHAN_TASK_DELETE = "delete_all";

const SHAPE_L: PolicyKeyDef[] = [
  {
    key: "policy.orphan_task_disposition", shape: "L",
    values: [ORPHAN_TASK_KEEP, ORPHAN_TASK_MIDDLE, ORPHAN_TASK_DELETE],
    defaultValue: ORPHAN_TASK_MIDDLE,
    label: "任务失去最后一个宿主事件时怎么处置",
    help: "**唯一边约束是不变量，不是档位**（M-15(e)）：级联只在任务失去**最后一个**"
      + "宿主事件时才可能发生，不存在「非最后一条边也级联」的档。"
      + "keep＝一律留为孤儿；delete_untouched（默认）＝没人动过的（awaiting 且正文空）删、"
      + "已开工的留为孤儿并标记待处理；delete_all＝一律删。"
      + "**与 task.dept_poc:*@delete 耦合**：POC 不能删 ⟹ 任务归派发方，派发方撤锚点时"
      + "连带清理自洽；POC 能删 ⟹ 部门收到即拥有，只能留孤儿。",
  },
];

// ─── 汇总 ─────────────────────────────────────────────────────────────────────

export const POLICY_KEYS: readonly PolicyKeyDef[] = [
  ...EVENT_CREATOR, ...EVENT_OTHERS, ...REPORT_CREATOR, ...TASK_DEPT_POC,
  ...ASSET_UPLOADER, ...WIKI_CUE_DEPT, ...SHAPE_C, ...SHAPE_L,
];

const BY_KEY = new Map(POLICY_KEYS.map((d) => [d.key, d]));

export function policyDef(key: string): PolicyKeyDef | undefined {
  return BY_KEY.get(key);
}

export function isLegalValue(key: string, value: string): boolean {
  const def = BY_KEY.get(key);
  return def ? def.values.includes(value) : false;
}

export function defaultValueOf(key: string): string | undefined {
  return BY_KEY.get(key)?.defaultValue;
}

/** 形状 A：某 (type, actor) 下**可配**的行（底座不在其中，底座恒发）。 */
export function configurableRows(type: string, actor: string): PolicyKeyDef[] {
  return POLICY_KEYS.filter((d) => d.a?.type === type && d.a.actor === actor);
}
