/**
 * 音乐类模版（专辑 / 单曲 / 广播剧）。
 *
 * 对象照旧、说法不同：`scene` = 歌曲·段落，`script` = 歌词，`character` = 演唱者 / 角色。
 * 所以基线与戏剧类共用（`OPEN_BASELINE`）——人人能读曲目表与歌词，和剧组人人能读
 * 场次表与剧本是同一件事。**差别在谁能改**。
 *
 * 两处与戏剧类的关键分工差异：
 *
 *   1. **作曲兼结构编辑**。剧场里「场次 / 角色 / 标签组的增删改」归戏剧构作，音乐项目
 *      没有这个岗，曲目表的结构就是作曲排的。故音乐类的作曲 = 戏剧类的
 *      作曲 ∪ 戏剧构作，**比剧场里的同名岗位权限更大**——同名不同级，这正是角色
 *      权限键必须随模版走、不能留在一张全局表里的原因。
 *   2. **音乐制作 ≠ 制作人**。它不是纯管理岗，而是半创意半管理：约棚监棚、素材整理
 *      （传版本 / 改元数据）、排曲目顺序，都在它手上，所以权限面比剧场的舞监宽。
 *      与制作人的分界不在宽窄而在**性质**——它一枚治理键都没有（授权、成员、角色
 *      权限集全不碰），那些是制作人的通配全集。
 *
 * cue 类型注册表**留空**：音乐项目没有 cue 表这个概念。哪个项目要用，自己在配置中心
 * 建类型 + 配声明行即可（机制与剧场完全一样，零代码）。
 */
import type { ProductionTemplate } from "../production-template";
import {
  OPEN_BASELINE, PRODUCER_KEYS, STRUCTURE_EDIT, SCRIPT_EDIT, SCHEDULE_ADMIN,
  ASSET_UPLOAD, ASSET_NEW_VERSION, ASSET_META_EDIT, MOUNT_ATTACH,
  policiesFromAnswers,
} from "./shared";

export const MUSIC_DEPT_TREE = [
  { name: "创作组" },
  { name: "艺人组" },
  { name: "制作组" },
  { name: "发行组" },
] as const;

export const MUSIC_DEPT_PERMISSIONS: Record<string, readonly string[]> = {
  // demo / 谱面 / 词稿
  创作组: [ASSET_UPLOAD],
  // 棚里出来的每一版都要能传，且能给同一条素材回传新版本（混音 v1..v9 是日常）
  制作组: [ASSET_UPLOAD, ASSET_NEW_VERSION],
  // 物料与成品
  发行组: [ASSET_UPLOAD],
  // 艺人组：基线足够（读曲目、读歌词、看通告、传自己的素材由创作组/制作组代管）
};

export const MUSIC_ROLES = [
  "制作人",
  "音乐制作",
  "作曲", "编曲", "作词",
  "录音", "混音", "母带",
  "宣发",
  "歌手", "乐手", "经纪人",
];

export const MUSIC_ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  制作人: PRODUCER_KEYS,

  // 半创意半管理：约棚监棚（事件）、排期通告（节点）、素材整理（传 / 回传新版本 /
  // 改元数据）、曲目结构与顺序。**不含授权与成员管理**——那才是制作人与它的分界。
  音乐制作: [
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
    ...SCHEDULE_ADMIN,
    ASSET_UPLOAD, ASSET_NEW_VERSION, ASSET_META_EDIT,
    ...STRUCTURE_EDIT, "node:scene/*/music@edit",
  ],

  // 曲目表的结构就是作曲排的（剧场里这活归戏剧构作）
  作曲: [...STRUCTURE_EDIT, "node:scene/*/music@edit", ASSET_UPLOAD, ...MOUNT_ATTACH],
  编曲: ["node:scene/*/music@edit", ASSET_UPLOAD, ...MOUNT_ATTACH],
  // 歌词 = script 正文
  作词: SCRIPT_EDIT,

  // 录音 / 混音 / 母带：零行——职能是素材的产出与迭代，走制作组部门区间
  // （与剧场的执行族同理：给部门，不给人）

  // 对外物料与通告归宣发；对外分享链接的资格已在基线（shares@create），
  // 项目层是否放行由 policy.share_token_enabled 串联
  宣发: [
    "node:announcement/*@create",
    "node:announcement/*@edit",
    "node:announcement/*@delete",
  ],

  // 歌手 / 乐手：零行（基线即全部）
  经纪人: ["node:task/*@view"],
};

/**
 * 宽松档：小团队、协作密度高、对外发行是常态。
 *   - 允许对外分享链接（宣发的日常出口；剧场默认关是因为剧目物料受版权与档期约束）
 *   - 创建者自主发布 / 删除自己建的事件（棚期变动频繁，走统筹审批太慢）
 *   - 任务归执行部门（收到即拥有）——四五个人的团队里，派活的人未必是最懂进度的人
 */
export const MUSIC_POLICIES = policiesFromAnswers({
  share_token: "yes",
  creator_publish_event: "yes",
  creator_delete_event: "yes",
  task_ownership: "dept",
});

export const MUSIC_TEMPLATE: ProductionTemplate = {
  key: "music",
  label: "音乐类（专辑 / 单曲 / 广播剧）",
  roles: {
    names: MUSIC_ROLES,
    baseline: OPEN_BASELINE,
    permissions: MUSIC_ROLE_PERMISSIONS,
  },
  deptTree: MUSIC_DEPT_TREE,
  deptPermissions: MUSIC_DEPT_PERMISSIONS,
  cueTemplateTypes: [],
  cueDeclarations: [],
  policies: MUSIC_POLICIES,
  approval: { ttlHours: 24 },
};
