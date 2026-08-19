/**
 * 影视类模版（短片 / 电影 / 电视剧）。
 *
 * 结构接近戏剧类（有剧本、有场次、有角色、有现场），但**授权哲学相反**：剧场默认
 * 开放（人人读剧本与场次表），影视默认收紧——剧本、场次、素材**非必要不授予**。
 *
 * ## 收紧的落点是基线，不是门
 *
 * 基线只留「不看就没法参与项目」的那几枚：通告、制作节点、成员名字、项目信息、事件
 * 时间地点。剧本 / 场次 / 角色 / 素材**一枚都不在基线里**，要读的人逐角色显式给。
 *
 * 这条链的机制前提（`lib/template-seeders/roles.ts`）：基线是合并进**每个角色**的行集，
 * 所以「有 role 才看得见，没 role 什么都看不到」是自然结果，不需要额外机制。
 *
 * ## 一处有意的宽松：演员拿全本
 *
 * 系统没有 per-scene 的授权粒度，给不了「只给自己的戏份」。不给就等于演员看不到剧本，
 * 项目跑不起来。故演员拿剧本正文的 blocks 读面 + 角色面。要更严只有两条路：
 * 把剧本按场拆成多个 script（产品层），或让演员走申请流（把这枚从模版里删掉即可）。
 */
import type { ProductionTemplate } from "../production-template";
import {
  PRODUCER_KEYS, SCENE_VIEW, CHARACTER_VIEW, SCRIPT_READ, SCRIPT_EDIT,
  STRUCTURE_EDIT, SCHEDULE_ADMIN, ASSET_LIST_VIEW, ASSET_FILE_VIEW,
  ASSET_UPLOAD, ASSET_NEW_VERSION, policiesFromAnswers,
} from "./shared";

/** 极简基线：只留「不看就没法参与」的那几枚。对照 OPEN_BASELINE 少掉的是
 *  script / scene / character / asset / cue_list 全部读面，以及成员联系方式。 */
const FILM_BASELINE: readonly string[] = [
  "node:announcement/*@view",
  "node:milestone/*@view",
  "node:member/*/meta@view",
  "node:production/*/meta@view",
  "node:event/*/meta@view",
  "node:event/*/details@view",
  "node:event/*/followers@create",
  // 建文档的资格不等于能读别人的文档（读面默认不可见），故不违背收紧原则
  "node:wiki/*@create",
];

/** 素材列表可见 + 文件本体可取。分两枚是有意的：很多岗位只需要知道「有这个素材」。 */
const ASSET_READ = [ASSET_LIST_VIEW, ASSET_FILE_VIEW];

/** 现场统筹（制片 / 执行制片共用的事件面）。 */
const PRODUCTION_OFFICE: readonly string[] = [
  "node:event/*@create",
  "node:event/*@view",
  "node:event/*/call_sheet@view",
  "node:event/*/publication@view",
  "node:event/*/chat@create",
  "node:task/*@view",
  "node:member/*/contact@view",
];

const FILM_DEPT_TREE = [
  { name: "制作组" },
  { name: "导演组" },
  { name: "摄影组" },
  { name: "灯光组" },
  { name: "录音组" },
  {
    name: "美术组",
    children: [{ name: "置景" }, { name: "道具" }, { name: "服装" }, { name: "化妆" }],
  },
  { name: "后期组" },
  { name: "演员组" },
] as const;

/** 部门静态行只给素材面——剧本与场次的读权按岗位给（部门里未必人人该读）。
 *  伞语义：美术组那一行下传给置景 / 道具 / 服装 / 化妆。 */
const FILM_DEPT_PERMISSIONS: Record<string, readonly string[]> = {
  制作组: [ASSET_LIST_VIEW, ASSET_UPLOAD],
  导演组: [...ASSET_READ],
  摄影组: [...ASSET_READ, ASSET_UPLOAD],
  灯光组: [ASSET_LIST_VIEW, ASSET_UPLOAD],
  录音组: [...ASSET_READ, ASSET_UPLOAD],
  美术组: [ASSET_LIST_VIEW, ASSET_UPLOAD],
  后期组: [...ASSET_READ, ASSET_UPLOAD, ASSET_NEW_VERSION],
  // 演员组：基线即全部（角色与剧本的读权在「演员」这个 role 上，不在部门）
};

const FILM_ROLES = [
  "制作人", "制片", "执行制片",
  "导演", "副导演", "编剧", "场记",
  "摄影指导", "摄影", "灯光指导", "灯光", "录音指导", "录音",
  "DIT", "美术指导", "道具", "服装", "化妆",
  "剪辑", "调色", "混音",
  "演员",
];

const FILM_ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  制作人: PRODUCER_KEYS,

  制片: [...PRODUCTION_OFFICE, ...SCHEDULE_ADMIN, ...SCRIPT_READ, ...SCENE_VIEW, ASSET_LIST_VIEW],
  执行制片: [...PRODUCTION_OFFICE, ...SCRIPT_READ, ...SCENE_VIEW],

  导演: [
    ...SCRIPT_READ, ...SCENE_VIEW, ...CHARACTER_VIEW, ...ASSET_READ,
    "node:scene/*/synopsis@edit",
    "node:scene/*/action_line@edit",
    "node:scene/*/stage_notes@edit",
    "node:dept/*/notes@create",
    "node:task/*@view",
  ],
  副导演: [...SCRIPT_READ, ...SCENE_VIEW, ...CHARACTER_VIEW, ASSET_LIST_VIEW, "node:task/*@view"],
  // 结构与正文都归编剧（影视没有戏剧构作这个岗）
  编剧: [...SCRIPT_READ, ...SCRIPT_EDIT, ...STRUCTURE_EDIT, ...SCENE_VIEW, ...CHARACTER_VIEW],
  // 场记记的是「这一条拍成了什么」
  场记: [...SCRIPT_READ, ...SCENE_VIEW, "node:scene/*/stage_notes@edit", ASSET_LIST_VIEW],

  // 各部门的指导岗要读剧本与场次；组员不读，走部门素材面
  摄影指导: [...SCRIPT_READ, ...SCENE_VIEW, ...ASSET_READ],
  灯光指导: [...SCRIPT_READ, ...SCENE_VIEW, ...ASSET_READ],
  录音指导: [...SCRIPT_READ, ...SCENE_VIEW, ...ASSET_READ],
  美术指导: [...SCRIPT_READ, ...SCENE_VIEW, ...CHARACTER_VIEW, ...ASSET_READ],
  // 摄影 / 灯光 / 录音 / 道具 / 服装 / 化妆：零行

  // 落卡、转码、命名
  DIT: [...ASSET_READ, ASSET_UPLOAD, ASSET_NEW_VERSION],
  剪辑: [...ASSET_READ, ASSET_UPLOAD, ...SCRIPT_READ, ...SCENE_VIEW],
  调色: [...ASSET_READ, ASSET_UPLOAD],
  混音: [...ASSET_READ, ASSET_UPLOAD],

  // 见文件头「一处有意的宽松」
  演员: [...SCRIPT_READ, ...CHARACTER_VIEW],
};

/**
 * 收紧档。每一条都对应影视组的实际规矩：
 *   - 禁对外分享链接 + 上传者不含对外分享（双保险：出口关掉，资格也不发）
 *   - 素材必须挂载才可见、文档不可设为全项目公开
 *   - 任务只对指派人与 POC 可见（谁在拍什么不该全组围观）
 *   - 部门 note 必须经 POC（意见走建制，不越级）
 *   - 排 call 与定名单只归跟组统筹，创建者不能自行发布 / 修订已发布的事件
 *   - 任务归派发方；事件创建者只能挂不能摘
 */
const FILM_POLICIES = policiesFromAnswers({
  share_token: "no",
  uploader_powers: "no_share",
  asset_public: "no",
  wiki_public: "no",
  task_dept_visibility: "no",
  note_channel: "poc_only",
  organizer_moderates_notes: "no",
  call_time: "sm_only",
  participant_list: "sm_only",
  creator_attach: "attach_only",
  creator_revise_published: "no",
  task_ownership: "assigner",
  report_creator_publish: "no",
});

export const FILM_TEMPLATE: ProductionTemplate = {
  key: "film",
  label: "影视类（短片 / 电影 / 电视剧）",
  roles: {
    names: FILM_ROLES,
    baseline: FILM_BASELINE,
    permissions: FILM_ROLE_PERMISSIONS,
  },
  deptTree: FILM_DEPT_TREE,
  deptPermissions: FILM_DEPT_PERMISSIONS,
  cueTemplateTypes: [],
  cueDeclarations: [],
  policies: FILM_POLICIES,
  approval: { ttlHours: 24 },
};
