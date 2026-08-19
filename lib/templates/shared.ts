/**
 * 各套项目模版共用的零件。
 *
 * ## 对象模型是通用的，模版只改词汇与授权宽窄
 *
 * `script` = 剧本 / 歌词 / 脚本；`scene` = 幕·场 / 歌曲·段落 / 剧集·场 / 章节·节目；
 * `character` 到哪儿都是角色。**同一套树，不同的说法**——所以四套模版的差别从来不在
 * 「用什么对象」，只在两处：谁能改（角色 / 部门键），以及全员默认能看多少（基线）。
 *
 * 词汇本身（per-type 的显示名/别名）是另一个维度，不在模版层，见 #163 讨论。
 */

/**
 * 制作人的通配全集（批G G-1 终局）：主行 + 四保留段。**每套模版都必须带**——
 * 制作人是 M-14(c) 责任链上不可让渡的兜底持有者。
 * 类型通配不穿透治理域（RESERVED_TYPES = production / producer），故它不是治理键。
 */
export const PRODUCER_KEYS: readonly string[] = [
  "node:*/*@*",
  "node:*/*/assignees@*",
  "node:*/*/grants@*",
  "node:*/*/imports@create",
  "node:*/*/publication@*",
];

/**
 * 开放型项目的全员基线（戏剧 / 音乐 / MV 共用）。
 *
 * 基线回答的是「**全员默认能看到项目的哪些内容**」，与项目类型无关——剧组里人人能读
 * 剧本与场次表，乐队里人人能读歌词与曲目表，同一件事。类型差异体现在谁能**改**。
 *
 * 影视类是唯一的例外，它自定义一份极简基线（`film.ts`）。
 *
 * 不含 call_sheet（事件参与自动行 R-1/R-2 覆盖）、不含保留段（draft/publication/
 * grants/assignees/imports）、不含治理段（production 的写面 / member / role / dept 管理）。
 */
export const OPEN_BASELINE: readonly string[] = [
  "node:announcement/*@view",
  "node:asset/*/file@view",
  "node:asset/*/meta@view",
  "node:asset/*/shares@create",
  "node:character/*/biography@view",
  "node:character/*/gender@view",
  "node:character/*/members@view",
  "node:character/*/meta@view",
  "node:character/*/role_type@view",
  "node:cue_list/*/cues@view",
  "node:cue_list/*/cues/comments@create",
  "node:cue_list/*/meta@view",
  "node:event/*/details@view",
  "node:event/*/followers@create",
  "node:event/*/meta@view",
  "node:member/*/contact@view",
  "node:member/*/meta@view",
  "node:milestone/*@view",
  "node:production/*/meta@view",
  "node:production/*/mounts@view",
  "node:scene/*/action_line@view",
  "node:scene/*/meta@view",
  "node:scene/*/music@view",
  "node:scene/*/stage_notes@view",
  "node:scene/*/synopsis@view",
  "node:script/*/blocks@view",
  "node:script/*/comments@create",
  "node:wiki/*@create",
];

// ─── 常用键组（削基线的模版要逐个显式补回，故集中定义）────────────────────────

/** 场次五面读（scene 的内容面，非结构）。 */
export const SCENE_VIEW: readonly string[] = [
  "node:scene/*/meta@view",
  "node:scene/*/synopsis@view",
  "node:scene/*/action_line@view",
  "node:scene/*/music@view",
  "node:scene/*/stage_notes@view",
];

/** 角色五面读。 */
export const CHARACTER_VIEW: readonly string[] = [
  "node:character/*/meta@view",
  "node:character/*/biography@view",
  "node:character/*/gender@view",
  "node:character/*/members@view",
  "node:character/*/role_type@view",
];

/** 正文读 + 评论（script = 剧本 / 歌词 / 脚本）。 */
export const SCRIPT_READ: readonly string[] = [
  "node:script/*/blocks@view",
  "node:script/*/comments@create",
];

/** 素材列表可见（`meta`）与文件本体可取（`file`）是两枚键，收紧型模版按需分别给。 */
export const ASSET_LIST_VIEW = "node:asset/*/meta@view";
export const ASSET_FILE_VIEW = "node:asset/*/file@view";
/** 建素材条目 / 给已有素材回传新版本 / 改素材元数据——**三道不同的门**，别混用。 */
export const ASSET_UPLOAD = "node:asset/*@create";
export const ASSET_NEW_VERSION = "node:asset/*/file@create";
export const ASSET_META_EDIT = "node:asset/*/meta@edit";

/** 结构编辑（原「戏剧构作」那套）：场次 / 角色 / 标签组的增删改。
 *  音乐类的作曲通常兼这套活——曲目表的结构就是他排的。 */
export const STRUCTURE_EDIT: readonly string[] = [
  "node:scene/*@create",
  "node:scene/*@delete",
  "node:scene/*@edit",
  "node:scene/*/action_line@edit",
  "node:scene/*/meta/expected_duration@edit",
  "node:scene/*/meta/name@edit",
  "node:scene/*/meta/type@edit",
  "node:scene/*/stage_notes@edit",
  "node:scene/*/synopsis@edit",
  "node:character/*@create",
  "node:character/*@delete",
  "node:character/*@edit",
  "node:tag_group/*@create",
  "node:tag_group/*@delete",
  "node:tag_group/*@edit",
  "node:tag_group/*/options@create",
  "node:tag_group/*/options@delete",
];

/** 排练 / 录制段落标记（剧场排练标记、录音棚的段落标记是同一套对象）。 */
export const REHEARSAL_MARKS: readonly string[] = [
  "node:script/*/rehearsal_marks@view",
  "node:script/*/rehearsal_marks@create",
  "node:script/*/rehearsal_marks@edit",
  "node:script/*/rehearsal_marks@delete",
  "node:script/*/rehearsal_marks/position@edit",
];

/** 正文编辑（剧本 / 歌词 / 脚本本体，含分块字段与挂载）。 */
export const SCRIPT_EDIT: readonly string[] = [
  "node:script/*/blocks@create",
  "node:script/*/blocks@delete",
  "node:script/*/blocks@edit",
  "node:script/*/blocks/character@edit",
  "node:script/*/blocks/position@edit",
  "node:script/*/blocks/tags@edit",
  "node:script/*/blocks/type@edit",
  "node:script/*/mounts@create",
];

/** 通告与制作节点的管理（制作助理 / 制片 / 宣发一类的统筹位）。 */
export const SCHEDULE_ADMIN: readonly string[] = [
  "node:announcement/*@create",
  "node:announcement/*@edit",
  "node:announcement/*@delete",
  "node:milestone/*@create",
  "node:milestone/*@edit",
  "node:milestone/*@delete",
];

// ─── cue 声明行的两档 ─────────────────────────────────────────────────────────

/** 设计侧全档：建表 + 整表读写 + cue 增删 + 转授。 */
export const CUE_OWNER_SET = ["@view", "@edit", "cues@create", "cues@delete", "grants@edit"] as const;
/** 执行侧受益档：只读（评论已含全员基线）。运行期改 cue 走设计侧或申请流。 */
export const CUE_VIEWER_SET = ["@view"] as const;

/** 声明一行「本部门能建这类 cue 表」。 */
export const own = (dept: string, template: string) =>
  ({ dept, template, canCreate: true, permissions: CUE_OWNER_SET });
/** 声明一行「本部门看得到这类 cue 表，但不建」。 */
export const see = (dept: string, template: string) =>
  ({ dept, template, canCreate: false, permissions: CUE_VIEWER_SET });

// ─── 策略：按题作答，而不是逐键填 ─────────────────────────────────────────────

import { POLICY_QUESTIONS } from "../policy-questions";

/**
 * 把「19 道题的选项」展开成策略键值。
 *
 * 为什么模版不直接写键：一道语义题往往同时定多个键（§6.4 纪律 3），逐键填等于放弃
 * 题库的互斥保证——能配出「没有任何人能排 call」这种组合。按题作答则结构上配不出来。
 *
 * 题 id / 答案 id 写错会**当场抛**：模版是代码常量，这属于编译期级别的错误，
 * 不该等到 validate 才发现（那时错的键名已经被当成「未知策略键」报出来，指向不了原因）。
 */
export function policiesFromAnswers(
  answers: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [questionId, answerId] of Object.entries(answers)) {
    const q = POLICY_QUESTIONS.find((x) => x.id === questionId);
    if (!q) throw new Error(`[policiesFromAnswers] 未知策略题：${questionId}`);
    const a = q.answers.find((x) => x.id === answerId);
    if (!a) {
      throw new Error(
        `[policiesFromAnswers] 题「${q.title}」没有答案 ${answerId}`
        + `（可选：${q.answers.map((x) => x.id).join(" / ")}）`,
      );
    }
    Object.assign(out, a.values);
  }
  return out;
}
