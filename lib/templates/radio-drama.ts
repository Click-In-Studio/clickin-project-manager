/**
 * 广播剧 / 有声剧模版。
 *
 * 公式：**戏剧类 − 舞台相关 + 音乐类的录音相关**。它不是「音乐类加一个导演」——
 * 广播剧有完整的戏剧建制（编剧、戏剧构作、导演、演出监督），只是舞台那一整层不存在：
 * 没有灯光、追光、舞美、机械、多媒体、抢妆、外场，也没有场上执行族。留下来的是
 * 剧本 → 排戏 → 进棚 → 后期这条线。
 *
 * 三处与戏剧类的对应关系：
 *
 *   · **监督**对应舞台监督——同一个统筹位（约棚、定名单、发布、报告），只是现场在
 *     录音棚而不在剧场。故它拿的是舞台监督那套键。
 *   · **音效设计**对应音响设计——广播剧的音效不是辅助而是主创，一切场景靠它建立。
 *     职能同样走 cue 声明行（音效表），role 零行。
 *   · **录音 / 混音 / 母带**从音乐类搬过来，职能走声音组部门区间（给部门不给人）。
 *
 * cue 类型只留两个（音效 / 音乐）——把戏剧类那八个里的舞台相关全部去掉，正是上面那条
 * 减法的落点。
 */
import type { ProductionTemplate } from "../production-template";
import {
  OPEN_BASELINE, PRODUCER_KEYS, STRUCTURE_EDIT, SCRIPT_EDIT, REHEARSAL_MARKS,
  SCHEDULE_ADMIN, ASSET_UPLOAD, ASSET_NEW_VERSION, MOUNT_ATTACH, policiesFromAnswers,
} from "./shared";

const DEPT_TREE = [
  {
    name: "创作组",
    children: [{ name: "剧本部门" }, { name: "导演部门" }, { name: "音乐部门" }],
  },
  {
    name: "声音组",
    children: [{ name: "音效设计" }, { name: "录音" }, { name: "混音" }],
  },
  { name: "卡司组", children: [{ name: "配音演员" }] },
  { name: "管理组", children: [{ name: "制作管理组" }, { name: "监督组" }] },
  { name: "发行组" },
] as const;

const DEPT_PERMISSIONS: Record<string, readonly string[]> = {
  创作组: [ASSET_UPLOAD, "node:script/*/rehearsal_marks@view"],
  // 棚里每一轨、每一版都要能传，且能给同一条素材回传新版本
  声音组: [ASSET_UPLOAD, ASSET_NEW_VERSION],
  // 段落标记只读（对着标记进棚录）
  卡司组: ["node:script/*/rehearsal_marks@view"],
  管理组: [ASSET_UPLOAD],
  制作管理组: [
    ...SCHEDULE_ADMIN,
    "node:task/*@view",
    "node:event/*/reports@view",
    "node:event/*/publication@view",
  ],
  // 与戏剧类的舞台监督组同构：统筹全档，call_sheet 不走通配（事件参与自动行）
  监督组: [
    "node:event/*@create",
    "node:event/*/tasks@view", "node:event/*/tasks@create", "node:event/*/tasks@delete",
    "node:event/*/reports@create", "node:event/*/reports@edit", "node:event/*/reports@delete",
    "node:event/*/publication@create", "node:event/*/publication@delete",
    "node:task/*@edit", "node:task/*/assignees@edit",
    "node:announcement/*@create", "node:announcement/*@edit", "node:announcement/*@delete",
    "node:dept/*/notes@create",
  ],
  发行组: [ASSET_UPLOAD],
};

const ROLES = [
  "制作人", "监督", "制作助理",
  "编剧", "戏剧构作", "导演",
  "音效设计", "作曲", "编曲",
  "录音", "混音", "母带",
  "配音演员", "宣发",
];

const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  制作人: PRODUCER_KEYS,

  // 舞台监督那套（现场在棚里）。建表资格不在这里——走 cue 声明行。
  监督: [
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
  制作助理: [...SCHEDULE_ADMIN, "node:task/*@view"],

  编剧: [...SCRIPT_EDIT, ...STRUCTURE_EDIT, ...REHEARSAL_MARKS],
  戏剧构作: STRUCTURE_EDIT,
  导演: [
    "node:scene/*/synopsis@edit",
    "node:scene/*/action_line@edit",
    "node:scene/*/music@edit",
    "node:scene/*/stage_notes@edit",
    ...REHEARSAL_MARKS,
    "node:dept/*/notes@create",
    "node:task/*@view",
    "node:event/*/publication@view",
  ],

  // 音效设计：零行——主创职能全在音效表的声明行上（与剧场的设计族同理）
  作曲: ["node:scene/*/music@edit", ASSET_UPLOAD, ...MOUNT_ATTACH],
  编曲: ["node:scene/*/music@edit", ASSET_UPLOAD, ...MOUNT_ATTACH],

  // 录音 / 混音 / 母带：零行，走声音组部门区间
  // 配音演员：零行（基线即全部）

  宣发: [
    "node:announcement/*@create",
    "node:announcement/*@edit",
    "node:announcement/*@delete",
  ],
};

const CUE_TYPES = [
  { key: "音效", abbrHint: "SQ", creatorRoles: ["音效设计"] },
  { key: "音乐", abbrHint: "MQ", creatorRoles: ["作曲", "编曲"] },
];

const OWNER_SET = ["@view", "@edit", "cues@create", "cues@delete", "grants@edit"] as const;
const VIEWER_SET = ["@view"] as const;

const CUE_DECLARATIONS = [
  { dept: "音效设计", template: "音效", canCreate: true, permissions: OWNER_SET },
  { dept: "音乐部门", template: "音乐", canCreate: true, permissions: OWNER_SET },
  // 录音对着音效表进棚；混音两张都要看（要按点位摆声音）
  { dept: "录音", template: "音效", canCreate: false, permissions: VIEWER_SET },
  { dept: "混音", template: "音效", canCreate: false, permissions: VIEWER_SET },
  { dept: "混音", template: "音乐", canCreate: false, permissions: VIEWER_SET },
  // 监督组统筹要看，但不建表
  { dept: "监督组", template: "音效", canCreate: false, permissions: VIEWER_SET },
  { dept: "监督组", template: "音乐", canCreate: false, permissions: VIEWER_SET },
];

export const RADIO_DRAMA_TEMPLATE: ProductionTemplate = {
  key: "radio_drama",
  label: "广播剧 / 有声剧",
  roles: {
    names: ROLES,
    baseline: OPEN_BASELINE,
    permissions: ROLE_PERMISSIONS,
  },
  deptTree: DEPT_TREE,
  deptPermissions: DEPT_PERMISSIONS,
  cueTemplateTypes: CUE_TYPES,
  cueDeclarations: CUE_DECLARATIONS,
  /** 有发行属性故开对外分享出口；其余保持默认——它有导演与监督建制，
   *  发布权归监督（不像音乐类那样把发布放给创建者）。 */
  policies: policiesFromAnswers({ share_token: "yes" }),
  approval: { ttlHours: 24 },
};
