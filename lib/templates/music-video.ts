/**
 * 音乐 MV 模版 = 音乐类 + 一个视频组。
 *
 * 复用音乐类的部门、角色与权限（`music.ts` 导出的那几份），加视频组与八个拍摄岗位。
 * 复用而非另抄一份：MV 的音乐侧工作与专辑**完全同构**（同一批人、同一套曲目与歌词），
 * 抄一份就等于给自己留两处要同步改的地方。
 *
 * 拍摄岗位全部零行：职能走视频组部门区间（与剧场执行族同理——给部门，不给人，
 * 人员进出部门时区间自动伸缩）。例外是场记与 DIT，它们有明确的**内容**职责。
 */
import type { ProductionTemplate } from "../production-template";
import { OPEN_BASELINE, ASSET_UPLOAD, ASSET_NEW_VERSION, policiesFromAnswers } from "./shared";
import {
  MUSIC_DEPT_TREE, MUSIC_DEPT_PERMISSIONS, MUSIC_ROLES, MUSIC_ROLE_PERMISSIONS,
} from "./music";

const VIDEO_ROLES = ["制片", "摄影", "灯光", "场记", "DIT", "妆造", "服装", "道具"];

export const MUSIC_VIDEO_TEMPLATE: ProductionTemplate = {
  key: "music_video",
  label: "音乐 MV",
  roles: {
    names: [...MUSIC_ROLES, ...VIDEO_ROLES],
    baseline: OPEN_BASELINE,
    permissions: {
      ...MUSIC_ROLE_PERMISSIONS,
      // 现场统筹（音乐侧的统筹是「音乐制作」，拍摄侧是制片，两条线并行）
      制片: [
        "node:event/*@create",
        "node:event/*@view",
        "node:event/*/call_sheet@view",
        "node:event/*/publication@view",
        "node:task/*@view",
      ],
      // 场记记的是「这一条拍成了什么」——落在场次的现场笔记面
      场记: ["node:scene/*/stage_notes@edit"],
      // 落卡与转码：DIT 不只是上传新条目，还要给同一条素材回传新版本
      DIT: [ASSET_UPLOAD, ASSET_NEW_VERSION],
      // 摄影 / 灯光 / 妆造 / 服装 / 道具：零行，走视频组区间
    },
  },
  deptTree: [...MUSIC_DEPT_TREE, { name: "视频组" }],
  deptPermissions: {
    ...MUSIC_DEPT_PERMISSIONS,
    // 拍摄素材量最大的一组
    视频组: [ASSET_UPLOAD],
  },
  cueTemplateTypes: [],
  cueDeclarations: [],
  /**
   * 音乐类的宽松档，但**上传者不含对外分享**：毛片与未过审的成片不该由单人决定外发。
   * 项目层的对外出口仍然开着（宣发要用），只是收口到能拿 shares 资格的人。
   */
  policies: policiesFromAnswers({
    share_token: "yes",
    creator_publish_event: "yes",
    creator_delete_event: "yes",
    task_ownership: "dept",
    uploader_powers: "no_share",
  }),
  approval: { ttlHours: 24 },
};
