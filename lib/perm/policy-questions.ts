/**
 * 策略配置中心的**语义层**：把 64 个策略键翻译成 19 道人话问题。
 *
 * 定稿见 MindWeave《权限策略中心-题库草案》（第二版），设计依据见
 * 《权限系统-不变量与策略汇总》§6。
 *
 * ## 为什么是「问题 + 互斥答案」而不是一堆开关
 *
 * 勾选式允许把一件事的所有持钥方全关掉，配出「没有任何人能排 call」的演出。
 * 问题式的答案互斥、且每个答案都声明能力去了哪条通道，结构上配不出来。
 *
 * ## 「去向声明」（`disposition`）不是文案，是常量的一部分
 *
 * 棘轮断言的是**声明完整性**——每个答案必须从封闭词汇表里说明「选了它之后这件事还能
 * 被谁做」，不得留空。它**不是能力存在性证明**：拿到一个键有四条通道（自动定式 /
 * 区间自确认 / 审批发行·直接授权 / 旁路），策略只管第一条；能力可经区间通道拿到，而
 * 区间**逐演出可配**，所以「有没有人能做 X」根本无法静态证明。
 *
 * 真正防住的东西是：**某个答案在设计时压根没想过「关掉之后谁来做」**。
 *
 * 词汇表三类 + 一个例外：
 *   - `actor`   动作角色（creator / poc / 跟组舞监…）——**结构性**，定式直接发
 *   - `scope`   区间通道——「被授予此键的角色 / 部门成员可自行激活」，逐演出可配
 *   - `fallback` 兜底——制作人全集（三重保护）与 owner（schema NOT NULL）
 *   - `closesFeature` **唯一合法的「无去向」**：关的是功能本身，不是把权柄挪给别人
 *
 * ## 纪律
 *
 *   - **不许写 role name / dept 名**：`ROLE_NAMES` 是默认模版名单**不是白名单**，
 *     剧组可删可改名，拿它当判据是把棘轮建在流沙上。「跟组舞监」不同——它是
 *     `event_stage_manager` 表里的 per-event 数据，指派了就存在。
 *   - **制作人只作兜底，不作方案**：写「找制作人」会让剧组以为没有别的路，实际上
 *     他们自己配个角色区间就行。
 *   - **答案是展示层，模版存键值**：以后改措辞、拆题、加选项都不影响存量演出。
 *   - **先是后否**：肯定式答案永远排在否定式之前，**与默认值无关**。默认是哪一档由
 *     键值决定（`matchAnswer`），跟顺序没有关系；把「不能」摆在第一行会让人以为那是
 *     推荐项。有棘轮盯着（`policy-questions.test.ts`）。
 */
import { POLICY_ON, POLICY_OFF, ORPHAN_TASK_KEEP, ORPHAN_TASK_MIDDLE, ORPHAN_TASK_DELETE } from "./policy-keys";

export type Disposition =
  | { kind: "actor"; label: string }
  | { kind: "scope"; label: string }
  | { kind: "fallback" }
  | { kind: "closesFeature" };

const ACTOR = (label: string): Disposition => ({ kind: "actor", label });
const SCOPE = (label: string): Disposition => ({ kind: "scope", label });
const FALLBACK: Disposition = { kind: "fallback" };
const CLOSES: Disposition = { kind: "closesFeature" };

export type PolicyAnswer = {
  id: string;
  label: string;
  /** 选中即**覆盖**该题涉及的全部键（§6.4 纪律 3，不做 merge）。 */
  values: Record<string, string>;
  /** 选了它之后这件事还能被谁做。空数组非法（除非含 closesFeature）。 */
  disposition: Disposition[];
};

export type PolicyQuestion = {
  id: string;
  group: string;
  title: string;
  /** 后果说明——写「会发生什么」，不要复述题面。 */
  help?: string;
  /** 出口类：UI 必须显著警示。 */
  danger?: boolean;
  answers: PolicyAnswer[];
};

const ON = POLICY_ON;
const OFF = POLICY_OFF;

// 便捷：一组键同取一个值
const all = (keys: readonly string[], v: string): Record<string, string> =>
  Object.fromEntries(keys.map((k) => [k, v]));

const EVENT_SM_ASSIGNEES = [
  "event.stage_manager:assignees@create", "event.stage_manager:assignees@delete",
] as const;
const EVENT_CREATOR_ASSIGNEES = [
  "event.creator:assignees@create", "event.creator:assignees@delete",
] as const;

export const POLICY_QUESTIONS: readonly PolicyQuestion[] = [
  // ── 事件 ────────────────────────────────────────────────────────────────
  {
    id: "call_time", group: "事件", title: "谁能排 call time？",
    answers: [
      {
        id: "creator_and_sm", label: "事件创建者与跟组舞监",
        values: { "event.creator:call_sheet@edit": ON, "event.stage_manager:call_sheet@edit": ON },
        disposition: [ACTOR("事件创建者"), ACTOR("跟组舞监")],
      },
      {
        id: "sm_only", label: "仅跟组舞监",
        values: { "event.creator:call_sheet@edit": OFF, "event.stage_manager:call_sheet@edit": ON },
        disposition: [ACTOR("跟组舞监")],
      },
    ],
  },
  {
    id: "creator_publish_event", group: "事件",
    title: "事件创建者能否发布自己创建的事件？",
    help: "这只管创建者**自己创建**的事件；谁能发布任意事件由角色权限决定，不在此处。",
    answers: [
      {
        id: "yes", label: "可以",
        values: { "event.creator:publication@create": ON },
        disposition: [ACTOR("事件创建者"), SCOPE("被授予事件发布权的角色 / 部门成员")],
      },
      {
        id: "no", label: "不能——发布另行授权",
        values: { "event.creator:publication@create": OFF },
        disposition: [SCOPE("被授予事件发布权的角色 / 部门成员"), FALLBACK],
      },
    ],
  },
  {
    id: "creator_revise_published", group: "事件",
    title: "事件创建者能否撤回、修订已发布的事件？",
    help: "修订已发布内容是敏感行为——他人可能已按旧版本行动。",
    answers: [
      {
        id: "yes", label: "可以",
        values: {
          "event.creator:publication@edit": ON, "event.creator:publication@delete": ON,
        },
        disposition: [ACTOR("事件创建者")],
      },
      {
        id: "no", label: "不可以",
        values: {
          "event.creator:publication@edit": OFF, "event.creator:publication@delete": OFF,
        },
        disposition: [SCOPE("被授予对应发布面权限的角色 / 部门成员"), FALLBACK],
      },
    ],
  },
  {
    id: "participant_list", group: "事件", title: "谁能定参会名单？",
    answers: [
      {
        id: "creator_and_sm", label: "事件创建者与跟组舞监",
        values: { ...all(EVENT_CREATOR_ASSIGNEES, ON), ...all(EVENT_SM_ASSIGNEES, ON) },
        disposition: [ACTOR("事件创建者"), ACTOR("跟组舞监")],
      },
      {
        id: "sm_only", label: "仅跟组舞监",
        values: { ...all(EVENT_CREATOR_ASSIGNEES, OFF), ...all(EVENT_SM_ASSIGNEES, ON) },
        disposition: [ACTOR("跟组舞监")],
      },
      {
        id: "creator_only", label: "仅事件创建者",
        values: { ...all(EVENT_CREATOR_ASSIGNEES, ON), ...all(EVENT_SM_ASSIGNEES, OFF) },
        disposition: [ACTOR("事件创建者")],
      },
    ],
  },
  {
    id: "creator_delete_event", group: "事件",
    title: "事件创建者能否删除自己创建的事件？",
    help: "事件有对外承诺性质，他人已按它安排行程。松的剧组可打开——建错了自己删。",
    answers: [
      {
        id: "yes", label: "可以",
        values: { "event.creator:*@delete": ON },
        disposition: [ACTOR("事件创建者")],
      },
      {
        id: "no", label: "不能",
        values: { "event.creator:*@delete": OFF },
        disposition: [SCOPE("被授予事件删除权的角色 / 部门成员"), FALLBACK],
      },
    ],
  },
  {
    id: "creator_attach", group: "事件",
    title: "事件创建者能否把任务、报告挂到自己的事件上，以及摘下来？",
    help: "**摘下来 ≠ 删掉**。任务本体仍归部门、报告文档仍在文档库里，只是不再挂在这个事件上。",
    answers: [
      {
        id: "both", label: "可以挂，也可以摘",
        values: {
          "event.creator:tasks@create": ON, "event.creator:tasks@delete": ON,
          "event.creator:reports@create": ON, "event.creator:reports@delete": ON,
        },
        disposition: [ACTOR("事件创建者")],
      },
      {
        id: "attach_only", label: "只能挂，不能摘",
        values: {
          "event.creator:tasks@create": ON, "event.creator:tasks@delete": OFF,
          "event.creator:reports@create": ON, "event.creator:reports@delete": OFF,
        },
        disposition: [ACTOR("事件创建者（挂）"), SCOPE("被授予摘除权的角色 / 部门成员"), FALLBACK],
      },
    ],
  },
  {
    id: "sm_reports", group: "事件", title: "跟组舞监对事件报告有哪些权限？",
    answers: [
      {
        id: "full", label: "完整（看 / 建 / 改 / 删）",
        values: all([
          "event.stage_manager:reports@view", "event.stage_manager:reports@create",
          "event.stage_manager:reports@edit", "event.stage_manager:reports@delete",
        ], ON),
        disposition: [ACTOR("跟组舞监")],
      },
      {
        id: "view_only", label: "只看不改",
        values: {
          "event.stage_manager:reports@view": ON,
          "event.stage_manager:reports@create": OFF,
          "event.stage_manager:reports@edit": OFF,
          "event.stage_manager:reports@delete": OFF,
        },
        disposition: [ACTOR("跟组舞监（查看）"), ACTOR("报告创建者"), FALLBACK],
      },
    ],
  },

  // ── 任务 ────────────────────────────────────────────────────────────────
  {
    id: "task_ownership", group: "任务", title: "部门收到任务后，任务归谁？",
    help: "**一题设两键**：任务删除权与「失去所属事件后如何处置」必须一致，否则会配出"
      + "「部门拥有 ＋ 别人替它清理」这种自相矛盾的组合。",
    answers: [
      {
        id: "assigner", label: "归派发方——部门只是执行",
        values: {
          "task.dept_poc:*@delete": OFF,
          "policy.orphan_task_disposition": ORPHAN_TASK_DELETE,
        },
        disposition: [ACTOR("任务派发方"), FALLBACK],
      },
      {
        id: "middle", label: "折中——部门已开工的保留",
        values: {
          "task.dept_poc:*@delete": OFF,
          "policy.orphan_task_disposition": ORPHAN_TASK_MIDDLE,
        },
        disposition: [ACTOR("任务派发方"), FALLBACK],
      },
      {
        id: "dept", label: "归执行部门——收到即拥有",
        values: {
          "task.dept_poc:*@delete": ON,
          "policy.orphan_task_disposition": ORPHAN_TASK_KEEP,
        },
        disposition: [ACTOR("部门 POC")],
      },
    ],
  },
  {
    id: "task_poc_powers", group: "任务", title: "部门 POC 对本部门任务的其余处置权？",
    help: "「指派」不在可关之列——任务分配归部门，关掉等于本部门没人能派活。",
    answers: [
      {
        id: "full", label: "完整（改内容、指派、转授）",
        values: all([
          "task.dept_poc:*@edit", "task.dept_poc:assignees@edit", "task.dept_poc:grants@edit",
        ], ON),
        disposition: [ACTOR("部门 POC")],
      },
      {
        id: "assign_only", label: "只能指派，不能改内容",
        values: {
          "task.dept_poc:*@edit": OFF,
          "task.dept_poc:assignees@edit": ON,
          "task.dept_poc:grants@edit": OFF,
        },
        disposition: [ACTOR("部门 POC（指派）"), SCOPE("被授予任务编辑权的角色 / 部门成员"), FALLBACK],
      },
    ],
  },
  {
    id: "task_dept_visibility", group: "任务", title: "已确认的任务是否对关联部门全员可见？",
    answers: [
      {
        id: "yes", label: "是",
        values: { "policy.task_dept_visibility": ON },
        disposition: [ACTOR("关联部门全体成员")],
      },
      {
        id: "no", label: "否——只有被指派的人和 POC",
        values: { "policy.task_dept_visibility": OFF },
        disposition: [ACTOR("被指派人"), ACTOR("部门 POC")],
      },
    ],
  },
  {
    id: "phase_dept_poc", group: "任务",
    title: "部门 POC 能否创建并管理本部门的阶段？",
    help: "阶段（phase）是项目大阶段区间，全员可见。此键只管部门级阶段；"
      + "production-level 阶段始终归持 phase 键的人（制作人兜底）。",
    answers: [
      {
        id: "yes", label: "可以",
        values: { "policy.phase_dept_poc_create": ON },
        disposition: [ACTOR("部门 POC"), SCOPE("被授予阶段管理权的角色 / 部门成员")],
      },
      {
        id: "no", label: "不可以",
        values: { "policy.phase_dept_poc_create": OFF },
        disposition: [SCOPE("被授予阶段管理权的角色 / 部门成员"), FALLBACK],
      },
    ],
  },

  // ── 报告与文档 ───────────────────────────────────────────────────────────
  {
    id: "report_creator_publish", group: "报告与文档",
    title: "报告创建者能否发布、修订、撤回报告？",
    answers: [
      {
        id: "yes", label: "可以",
        values: all([
          "report.creator:publication@create", "report.creator:publication@edit",
          "report.creator:publication@delete",
        ], ON),
        disposition: [ACTOR("报告创建者"), ACTOR("跟组舞监")],
      },
      {
        id: "no", label: "不可以——发布归跟组舞监",
        values: all([
          "report.creator:publication@create", "report.creator:publication@edit",
          "report.creator:publication@delete",
        ], OFF),
        disposition: [ACTOR("跟组舞监"), FALLBACK],
      },
    ],
  },
  {
    id: "report_creator_detach", group: "报告与文档",
    title: "报告创建者能否把报告从事件上撤下来？",
    help: "撤下来的是**挂载关系**，报告文档仍在文档库里，作者仍可访问。",
    answers: [
      {
        id: "yes", label: "可以",
        values: { "report.creator:*@delete": ON },
        disposition: [ACTOR("报告创建者"), ACTOR("跟组舞监")],
      },
      {
        id: "no", label: "不能",
        values: { "report.creator:*@delete": OFF },
        disposition: [ACTOR("跟组舞监"), FALLBACK],
      },
    ],
  },
  {
    id: "report_creator_notes", group: "报告与文档",
    title: "报告创建者能否增删报告下的 note？",
    answers: [
      {
        id: "yes", label: "可以",
        values: all(["report.creator:notes@create", "report.creator:notes@delete"], ON),
        disposition: [ACTOR("报告创建者")],
      },
      {
        id: "no", label: "不可以",
        values: all(["report.creator:notes@create", "report.creator:notes@delete"], OFF),
        disposition: [ACTOR("部门 POC"), FALLBACK],
      },
    ],
  },
  {
    id: "note_channel", group: "报告与文档", title: "部门 note 谁能提？",
    answers: [
      {
        id: "members", label: "本部门成员都能直接提",
        values: { "policy.note_create_requires_poc": OFF },
        disposition: [ACTOR("本部门成员"), ACTOR("部门 POC")],
      },
      {
        id: "poc_only", label: "必须经本部门 POC",
        values: { "policy.note_create_requires_poc": ON },
        disposition: [ACTOR("部门 POC")],
      },
    ],
  },
  {
    id: "organizer_moderates_notes", group: "报告与文档",
    title: "事件创建者能否管理任意部门的 note？",
    answers: [
      {
        id: "yes", label: "可以",
        values: { "policy.organizer_moderates_notes": ON },
        disposition: [ACTOR("事件创建者"), ACTOR("各部门 POC")],
      },
      {
        id: "no", label: "不可以——各部门自管",
        values: { "policy.organizer_moderates_notes": OFF },
        disposition: [ACTOR("各部门 POC")],
      },
    ],
  },

  // ── 素材与对外 ───────────────────────────────────────────────────────────
  {
    id: "share_token", group: "素材与对外", danger: true,
    title: "是否允许生成对外分享链接？",
    help: "分享链接的接收者**不是项目成员**——退出项目、撤销权限、权限到期**都不会**"
      + "使已发出的链接失效。关闭此项会**立即使所有已发出的链接失效**。",
    answers: [
      {
        id: "yes", label: "允许",
        values: { "policy.share_token_enabled": ON },
        disposition: [ACTOR("素材上传者"), SCOPE("被授予分享权的角色 / 部门成员")],
      },
      {
        id: "no", label: "不允许",
        values: { "policy.share_token_enabled": OFF },
        // 唯一合法的「无去向」：关的是功能本身，不是把权柄挪给别人
        disposition: [CLOSES],
      },
    ],
  },
  {
    id: "uploader_powers", group: "素材与对外", title: "上传者对自己上传的素材有哪些处置权？",
    answers: [
      {
        id: "full", label: "完整（删除、挂载、对外分享）",
        values: all([
          "asset.uploader:*@delete", "asset.uploader:publication@create",
          "asset.uploader:publication@delete", "asset.uploader:shares@create",
        ], ON),
        disposition: [ACTOR("上传者")],
      },
      {
        id: "no_delete", label: "不含删除",
        values: {
          "asset.uploader:*@delete": OFF,
          "asset.uploader:publication@create": ON,
          "asset.uploader:publication@delete": ON,
          "asset.uploader:shares@create": ON,
        },
        disposition: [ACTOR("上传者（挂载与分享）"), SCOPE("被授予素材删除权的角色 / 部门成员"), FALLBACK],
      },
      {
        id: "no_share", label: "不含对外分享",
        values: {
          "asset.uploader:*@delete": ON,
          "asset.uploader:publication@create": ON,
          "asset.uploader:publication@delete": ON,
          "asset.uploader:shares@create": OFF,
        },
        disposition: [ACTOR("上传者（删除与挂载）"), SCOPE("被授予分享权的角色 / 部门成员"), FALLBACK],
      },
    ],
  },
  {
    id: "asset_public", group: "素材与对外", title: "素材能否免挂载对全组可见？",
    help: "这不是对外公开——受众仍限本项目成员，且仍需该素材的查看权。",
    answers: [
      {
        id: "yes", label: "可以",
        values: { "policy.asset_public_enabled": ON },
        disposition: [ACTOR("持该素材查看权的成员")],
      },
      {
        id: "no", label: "不可以——必须挂载到某处才可见",
        values: { "policy.asset_public_enabled": OFF },
        disposition: [ACTOR("经挂载边可见的成员")],
      },
    ],
  },
  {
    id: "wiki_public", group: "素材与对外", title: "文档能否设为全项目公开？",
    help: "文档的「全项目公开」比素材的宽一档——它绕过所有个人权限，全体成员直接可见。",
    answers: [
      {
        id: "yes", label: "可以",
        values: { "policy.wiki_public_enabled": ON },
        disposition: [ACTOR("全体成员")],
      },
      {
        id: "no", label: "不可以",
        values: { "policy.wiki_public_enabled": OFF },
        disposition: [ACTOR("被授权者"), ACTOR("被分享的部门成员"), ACTOR("经挂载边可见者")],
      },
    ],
  },
];

// ─── 派生 ─────────────────────────────────────────────────────────────────────

/** 一道题涉及的全部键（取各答案键集的并——各答案必须覆盖同一组键，有棘轮）。 */
export function questionKeys(q: PolicyQuestion): string[] {
  const s = new Set<string>();
  for (const a of q.answers) for (const k of Object.keys(a.values)) s.add(k);
  return [...s];
}

/** 简单模式覆盖到的键；其余只在高级模式逐键可配。 */
export const QUESTION_COVERED_KEYS: ReadonlySet<string> = new Set(
  POLICY_QUESTIONS.flatMap(questionKeys),
);

/**
 * 当前键值命中哪个答案；都不命中返回 null＝**自定义**。
 *
 * §6.4 纪律 2：高级模式手改后组合可能不对应任何预设答案，UI **必须**显示「自定义」，
 * 不许静默显示最接近的那个——那会让人以为自己在 A、实际在 A′。
 */
export function matchAnswer(
  q: PolicyQuestion,
  current: ReadonlyMap<string, string>,
): PolicyAnswer | null {
  return q.answers.find((a) =>
    Object.entries(a.values).every(([k, v]) => current.get(k) === v)) ?? null;
}
