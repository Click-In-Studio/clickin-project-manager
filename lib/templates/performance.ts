/**
 * 演出类模版（音乐会 / 音乐节 / 综合晚会 / 线上演出）。
 *
 * 与戏剧类同一套骨架（设计 → 执行 → 舞监统筹 → cue 表），四处关键差异：
 *
 *   1. **没有编剧、没有作曲，最多有编曲**。节目单不是写出来的，是排出来的。
 *   2. **导演几乎等于编剧**——节目结构（顺序、串场、时长）就是导演定的，故导演在这套
 *      模版里拿 script 正文与结构编辑的全套，是本套模版里唯一的内容主创。
 *   3. **音响执行的岗位名换了一整套**：FoH（前场调音）/ Mon（返送）/ OB（转播混音），
 *      不是剧场的 A1 / A2 / 音效执行。
 *   4. **直播独立成组**。剧场里导播挂在多媒体部下面（大屏的一部分），演出里直播是一条
 *      平行产线：Camera Op + 导播 + 独立的机位与切换流程，故有自己的部门与 cue 归属。
 *
 * 剧本部门与卡司族随之改写：无剧本部门（无编剧），卡司组是歌手 / 乐手 / 主持而不是
 * 演员 / 歌队 / 舞蹈队。cue 类型沿用戏剧类那十个——演出的 cue 需求不比剧场少，
 * 唯一挪动的是「导播」的建表资格：从多媒体设计移到直播组。
 *
 * ## 不提供「多舞台 / 多艺人」维度（2026-08-19 定）
 *
 * 音乐节有多个舞台、多组艺人，但**模版不主动给这一层**——它与综合晚会本质相同，
 * 而「几个舞台、哪些艺人」是逐项目的事实，猜不出来。需要的剧组在部门树里给每个舞台
 * 或每个艺人建自己的子树即可（伞语义天然支持：A 舞台的区间键只下传给 A 舞台的人）。
 * 这不是欠账，是有意不做。
 */
import type { ProductionTemplate } from "../production-template";
import {
  OPEN_BASELINE, PRODUCER_KEYS, SCRIPT_EDIT, STRUCTURE_EDIT, REHEARSAL_MARKS,
  ASSET_UPLOAD, own, see,
} from "./shared";
import { THEATRE_CUE_TYPES, THEATRE_DEPT_PERMISSIONS } from "./theatre";

const DEPT_TREE = [
  // 无剧本部门（无编剧）；节目结构归导演部门
  { name: "创作组", children: [{ name: "导演部门" }, { name: "音乐部门" }] },
  {
    name: "设计组",
    children: [
      { name: "音响设计" }, { name: "舞美设计" }, { name: "灯光设计" },
      { name: "服化设计" }, { name: "多媒体设计" }, { name: "道具设计" },
    ],
  },
  {
    name: "执行组",
    children: [
      { name: "音响部" }, { name: "灯光部" }, { name: "舞台机械部" },
      { name: "多媒体部" }, { name: "剧务部" }, { name: "服化部" }, { name: "外场部" },
    ],
  },
  // 与执行组平级：直播是一条平行产线，不是大屏的附属
  { name: "直播组" },
  { name: "卡司组", children: [{ name: "歌手" }, { name: "乐手" }, { name: "主持" }] },
  { name: "管理组", children: [{ name: "制作管理组" }, { name: "舞台监督组" }] },
] as const;

/** 沿用戏剧类的静态区间行（同构的部门同权），加直播组。 */
const DEPT_PERMISSIONS: Record<string, readonly string[]> = {
  ...THEATRE_DEPT_PERMISSIONS,
  // 机位素材、回放、转播录像
  直播组: [ASSET_UPLOAD],
};

const ROLES = [
  // 管理族
  "制作人", "舞台监督", "后台舞台监督", "制作助理",
  // 创作族：无编剧 / 无戏剧构作 / 无作曲
  "导演", "音乐导演", "编曲", "编舞",
  // 设计族（零行：职能走部门声明行）
  "音响设计", "灯光设计", "舞美设计", "服化设计", "道具设计", "多媒体设计",
  // 执行族——音响三岗是演出制，不是剧场的 A1 / A2
  "FoH", "Mon", "OB",
  "灯光执行", "追光", "抢妆师", "化妆师",
  "多媒体执行", "舞台机械", "后场", "机动", "迎宾", "检票",
  // 直播族
  "Camera Op", "导播",
  // 卡司族
  "歌手", "乐手", "主持",
];

const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  制作人: PRODUCER_KEYS,

  // 与戏剧类同权（同一个统筹位）
  舞台监督: [
    "node:event/*@create",
    "node:event/*@view",
    "node:event/*/call_sheet@view",
    "node:event/*/chat@create",
    "node:event/*/publication@create",
    "node:event/*/publication@delete",
    "node:event/*/publication@view",
    "node:event/*/reports@view",
    "node:report/*@delete",
    "node:task/*@view",
    "node:task/*@delete",
  ],
  后台舞台监督: [
    "node:event/*@view",
    "node:event/*/publication@create",
    "node:event/*/publication@delete",
    "node:report/*@delete",
  ],
  制作助理: [
    "node:announcement/*@create", "node:announcement/*@edit", "node:announcement/*@delete",
    "node:milestone/*@create", "node:milestone/*@edit", "node:milestone/*@delete",
    "node:phase/*@create", "node:phase/*@edit", "node:phase/*@delete",
    "node:task/*@view",
  ],

  // 本套模版里唯一的内容主创：节目单的顺序、串场、时长都是它定的，
  // 故拿 script 正文 + 结构编辑全套（在戏剧类里这两套分属编剧与戏剧构作）
  导演: [
    ...SCRIPT_EDIT, ...STRUCTURE_EDIT, ...REHEARSAL_MARKS,
    "node:dept/*/notes@create",
    "node:task/*@view",
    "node:event/*/publication@view",
  ],
  音乐导演: [
    ...REHEARSAL_MARKS,
    "node:scene/*/music@edit",
    "node:task/*@view",
  ],
  编曲: ["node:scene/*/music@edit"],
  编舞: [...REHEARSAL_MARKS, "node:scene/*/action_line@edit", "node:task/*@view"],

  // 设计族 / 执行族 / 直播族 / 卡司族：零行——职能走部门声明行与部门区间
};

/** 沿用戏剧类的声明组，两处改动：导播的建表资格归直播组（剧场里在多媒体设计），
 *  且直播组要看催场（跟机靠催场点位）。 */
const CUE_DECLARATIONS = [
  own("音乐部门", "音乐"),
  own("音响设计", "音效"),
  { dept: "音响设计", template: "音乐", canCreate: false, permissions: ["@view", "@edit"] },
  own("灯光设计", "灯光"),
  own("灯光设计", "追光"),
  own("多媒体设计", "多媒体"),
  own("舞美设计", "舞台机械"),
  own("服化设计", "抢妆"),
  own("道具设计", "预设"),
  own("舞台监督组", "催场"),
  own("舞台监督组", "预设"),
  // 直播独立产线：导播表自己建
  own("直播组", "导播"),
  see("直播组", "催场"),
  see("音响部", "音效"),
  see("音响部", "音乐"),
  see("灯光部", "灯光"),
  see("灯光部", "追光"),
  see("多媒体部", "多媒体"),
  see("服化部", "抢妆"),
  see("舞台机械部", "舞台机械"),
  see("剧务部", "催场"),
  see("剧务部", "预设"),
];

export const PERFORMANCE_TEMPLATE: ProductionTemplate = {
  key: "performance",
  label: "演出类（音乐会 / 音乐节 / 晚会 / 线上演出）",
  roles: {
    names: ROLES,
    baseline: OPEN_BASELINE,
    permissions: ROLE_PERMISSIONS,
  },
  deptTree: DEPT_TREE,
  deptPermissions: DEPT_PERMISSIONS,
  cueTemplateTypes: THEATRE_CUE_TYPES,
  cueDeclarations: CUE_DECLARATIONS,
  // 与戏剧类同档（全默认）：同样是多人现场协作，发布归舞监、事件不由创建者删。
  policies: {},
  approval: { ttlHours: 24 },
};
