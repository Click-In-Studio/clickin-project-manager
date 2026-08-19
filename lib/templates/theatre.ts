/**
 * 戏剧类模版（音乐剧标准）——内容定稿见 MindWeave《基础模版-音乐剧角色与部门》
 * §2（角色权限）/ §3（部门树）/ §3.1（静态区间行）/ §3.2（cue 声明组）。
 *
 * 角色权限键与基线是从线上 `grant_template` 通用行**逐键搬过来**的，等价性由
 * `db/migrate-retire-grant-template.sql` 的迁移测试（invariance 层）机器验证。
 * 两条有意差异：`副导演` / `助理舞台监督` 的模板行不搬——它们是
 * `migrate-assistant-roles.sql` 拆分后的残留（复合职位已拆成 base role + tag），
 * 不在角色名单里，留着就是一组永远发不出去的死键。
 *
 * 策略全取代码默认：#236 那批默认值本来就是照剧场调的（账本 §5.7）。
 */
import type { ProductionTemplate } from "../production-template";

/** 五大组（组织树，区间宿主 + cue 类型归属）。 */
const DEPT_TREE = [
  {
    name: "创作组",
    children: [{ name: "剧本部门" }, { name: "导演部门" }, { name: "音乐部门" }],
  },
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
  { name: "卡司组", children: [{ name: "演员" }, { name: "乐手" }, { name: "歌队" }] },
  { name: "管理组", children: [{ name: "制作管理组" }, { name: "舞台监督组" }] },
] as const;

/** §3.1 静态区间行。伞语义沿树向下生效，故只挂在最上层需要的那一级。
 *  零 call_sheet 通配（事件参与自动行 R-1/R-2 覆盖）；零 imports（制作人专属）。 */
const DEPT_PERMISSIONS: Record<string, readonly string[]> = {
  // 创作资料上传；排练标记只读
  创作组: ["node:asset/*@create", "node:script/*/rehearsal_marks@view"],
  // 设计稿 / 图纸 / 模型上传
  设计组: ["node:asset/*@create"],
  舞美设计: ["node:scene/*/mounts@create", "node:script/*/mounts@create"],
  道具设计: ["node:scene/*/mounts@create", "node:script/*/mounts@create"],
  执行组: ["node:asset/*@create"],
  // 角色分配已含基线 character 五面；这里只补排练标记只读
  卡司组: ["node:script/*/rehearsal_marks@view"],
  管理组: ["node:asset/*@create"],
  制作管理组: [
    "node:milestone/*@create", "node:milestone/*@edit", "node:milestone/*@delete",
    "node:announcement/*@create", "node:announcement/*@edit", "node:announcement/*@delete",
    "node:task/*@view",
    // draft 日程与报告对制作管理可见
    "node:event/*/reports@view", "node:event/*/publication@view",
  ],
  舞台监督组: [
    "node:event/*@create",
    "node:event/*/tasks@view", "node:event/*/tasks@create", "node:event/*/tasks@delete",
    "node:event/*/reports@create", "node:event/*/reports@edit", "node:event/*/reports@delete",
    "node:event/*/publication@create", "node:event/*/publication@delete",
    "node:task/*@edit", "node:task/*/assignees@edit",
    "node:announcement/*@create", "node:announcement/*@edit", "node:announcement/*@delete",
    "node:dept/*/notes@create",
  ],
};

/** cue 模版类型。缩写是展示提示，命名规律 = 英文首字母 + Q。 */
const CUE_TYPES = [
  { key: "灯光",     abbrHint: "LQ", creatorRoles: ["灯光设计"] },
  { key: "追光",     abbrHint: "FQ", creatorRoles: ["灯光设计"] },
  { key: "音效",     abbrHint: "SQ", creatorRoles: ["音响设计"] },
  { key: "音乐",     abbrHint: "MQ", creatorRoles: ["音响设计", "作曲", "编曲"] },
  { key: "多媒体",   abbrHint: "VQ", creatorRoles: ["多媒体设计"] },
  { key: "舞台机械", abbrHint: "AQ", creatorRoles: ["舞美设计", "舞台监督"] },
  { key: "催场",     abbrHint: "CQ", creatorRoles: ["舞台监督"] },
  { key: "预设",     abbrHint: "PQ", creatorRoles: ["舞台监督", "道具设计"] },
  // §3.2 声明组用到但此前不在注册表里的两个类型（模版校验会挡住这种缺口）
  { key: "抢妆",     abbrHint: "QQ", creatorRoles: ["服化设计"] },
  { key: "导播",     abbrHint: "DQ", creatorRoles: ["多媒体设计"] },
];

/** 设计侧全档：建表 + 整表读写 + cue 增删 + 转授。 */
const OWNER_SET = ["@view", "@edit", "cues@create", "cues@delete", "grants@edit"] as const;
/** 执行侧受益档：只读（评论已含全员基线）。运行期改 cue 走设计侧或申请流。 */
const VIEWER_SET = ["@view"] as const;

const own = (dept: string, template: string) =>
  ({ dept, template, canCreate: true, permissions: OWNER_SET });
const see = (dept: string, template: string) =>
  ({ dept, template, canCreate: false, permissions: VIEWER_SET });

/** §3.2。执行侧受益不建表——「音响部 = 音效, 音乐」的旧语义是**看得到**，不是能建。 */
const CUE_DECLARATIONS = [
  own("音乐部门", "音乐"),
  own("音响设计", "音效"),
  // 混音需要看到并调整音乐表，但建表权归音乐部门
  { dept: "音响设计", template: "音乐", canCreate: false, permissions: ["@view", "@edit"] },
  own("灯光设计", "灯光"),
  own("灯光设计", "追光"),
  own("多媒体设计", "多媒体"),
  own("多媒体设计", "导播"),
  own("舞美设计", "舞台机械"),
  own("服化设计", "抢妆"),
  own("道具设计", "预设"),
  own("舞台监督组", "催场"),
  own("舞台监督组", "预设"),
  see("音响部", "音效"),
  see("音响部", "音乐"),
  see("灯光部", "灯光"),
  see("灯光部", "追光"),
  see("多媒体部", "多媒体"),
  see("多媒体部", "导播"),
  see("服化部", "抢妆"),
  see("舞台机械部", "舞台机械"),
  see("剧务部", "催场"),
  see("剧务部", "预设"),
];

/** 角色名单：管理族 / 创作族 / 设计族（零行）/ 执行族（零行）/ 卡司族（零行）。
 *  **这是默认模版名单，不是白名单**——剧组可增删改名，在用的自定义 role 不因不在
 *  名单里被删。 */
const ROLE_NAMES = [
  "制作人", "舞台监督", "后台舞台监督", "制作助理",
  "编剧", "戏剧构作", "导演", "音乐导演", "作曲", "编曲",
  "音响设计", "灯光设计", "舞美设计", "服化设计", "道具设计", "多媒体设计",
  "音效执行", "A1", "A2", "灯光执行", "追光", "抢妆师", "化妆师",
  "多媒体执行", "定机", "游机", "摇臂", "导播", "舞台机械", "后场", "机动",
  "迎宾", "检票",
  "演员", "乐手", "歌队",
];

export const THEATRE_TEMPLATE: ProductionTemplate = {
  key: "theatre",
  label: "戏剧类（音乐剧 / 话剧 / 演出）",
  roles: {
    names: ROLE_NAMES,
    baseline: [
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
    ],
    permissions: {
      "制作人": [
        "node:*/*@*",
        "node:*/*/assignees@*",
        "node:*/*/grants@*",
        "node:*/*/imports@create",
        "node:*/*/publication@*",
      ],
      "舞台监督": [
        "node:cue_list/*@create",
        "node:event/*@create",
        "node:event/*@view",
        "node:event/*/call_sheet@view",
        "node:event/*/chat@create",
        "node:event/*/publication@create",
        "node:event/*/publication@delete",
        "node:event/*/publication@view",
        "node:event/*/reports@view",
        "node:report/*@delete",
        "node:task/*@delete",
        "node:task/*@view",
      ],
      "后台舞台监督": [
        "node:event/*@view",
        "node:event/*/publication@create",
        "node:event/*/publication@delete",
        "node:report/*@delete",
      ],
      "制作助理": [
        "node:announcement/*@create",
        "node:announcement/*@delete",
        "node:announcement/*@edit",
        "node:milestone/*@create",
        "node:milestone/*@delete",
        "node:milestone/*@edit",
        "node:task/*@view",
      ],
      "编剧": [
        "node:character/*@create",
        "node:character/*@delete",
        "node:character/*@edit",
        "node:scene/*@create",
        "node:scene/*@delete",
        "node:scene/*@edit",
        "node:scene/*/action_line@edit",
        "node:scene/*/meta/expected_duration@edit",
        "node:scene/*/meta/name@edit",
        "node:scene/*/meta/type@edit",
        "node:scene/*/stage_notes@edit",
        "node:scene/*/synopsis@edit",
        "node:script/*/blocks@create",
        "node:script/*/blocks@delete",
        "node:script/*/blocks@edit",
        "node:script/*/blocks/character@edit",
        "node:script/*/blocks/position@edit",
        "node:script/*/blocks/tags@edit",
        "node:script/*/blocks/type@edit",
        "node:script/*/mounts@create",
        "node:script/*/rehearsal_marks@create",
        "node:script/*/rehearsal_marks@delete",
        "node:script/*/rehearsal_marks@edit",
        "node:script/*/rehearsal_marks@view",
        "node:script/*/rehearsal_marks/position@edit",
        "node:tag_group/*@create",
        "node:tag_group/*@delete",
        "node:tag_group/*@edit",
        "node:tag_group/*/options@create",
        "node:tag_group/*/options@delete",
      ],
      "戏剧构作": [
        "node:character/*@create",
        "node:character/*@delete",
        "node:character/*@edit",
        "node:scene/*@create",
        "node:scene/*@delete",
        "node:scene/*@edit",
        "node:scene/*/action_line@edit",
        "node:scene/*/meta/expected_duration@edit",
        "node:scene/*/meta/name@edit",
        "node:scene/*/meta/type@edit",
        "node:scene/*/stage_notes@edit",
        "node:scene/*/synopsis@edit",
        "node:tag_group/*@create",
        "node:tag_group/*@delete",
        "node:tag_group/*@edit",
        "node:tag_group/*/options@create",
        "node:tag_group/*/options@delete",
      ],
      "导演": [
        "node:dept/*/notes@create",
        "node:event/*/publication@view",
        "node:scene/*/action_line@edit",
        "node:scene/*/music@edit",
        "node:scene/*/stage_notes@edit",
        "node:scene/*/synopsis@edit",
        "node:script/*/rehearsal_marks@create",
        "node:script/*/rehearsal_marks@delete",
        "node:script/*/rehearsal_marks@edit",
        "node:script/*/rehearsal_marks@view",
        "node:script/*/rehearsal_marks/position@edit",
        "node:task/*@view",
      ],
      "音乐导演": [
        "node:cue_list/*@create",
        "node:scene/*/music@edit",
        "node:script/*/rehearsal_marks@create",
        "node:script/*/rehearsal_marks@delete",
        "node:script/*/rehearsal_marks@edit",
        "node:script/*/rehearsal_marks@view",
        "node:script/*/rehearsal_marks/position@edit",
        "node:task/*@view",
      ],
      "作曲": [
        "node:cue_list/*@create",
        "node:scene/*/music@edit",
      ],
      "编曲": [
        "node:cue_list/*@create",
        "node:scene/*/music@edit",
      ],
      "音响设计": [
        "node:cue_list/*@create",
      ],
      "灯光设计": [
        "node:cue_list/*@create",
      ],
      "舞美设计": [
        "node:cue_list/*@create",
      ],
      "服化设计": [
        "node:cue_list/*@create",
      ],
      "多媒体设计": [
        "node:cue_list/*@create",
      ],
    },
  },
  deptTree: DEPT_TREE,
  deptPermissions: DEPT_PERMISSIONS,
  cueTemplateTypes: CUE_TYPES,
  cueDeclarations: CUE_DECLARATIONS,
  policies: {},
  approval: { ttlHours: 24 },
};
