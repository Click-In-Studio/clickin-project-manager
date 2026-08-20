/**
 * 一人项目 / 其他——**空模版**。
 *
 * 没有部门、没有基线、没有 cue 类型、没有声明行，角色只有一个。一个人自己干活的项目
 * 不需要任何组织脚手架，硬塞一套只会让他先花十分钟删掉。
 *
 * ## 为什么不能真的「零角色」
 *
 * 「制作人」这一个 role 必须在，且必须持通配全集——M-14(c)：每个项目都要有一个
 * **不依赖旁路**的兜底持有者。owner 是代码级旁路（逃生舱），拿它充当承重墙会让
 * M-14 存在性子句恒真、什么也约束不住。所以空模版的下限就是这一个角色。
 *
 * ## 基线为空的后果（是设计，不是漏）
 *
 * 基线是合并进**每个角色**的行集，无角色成员拿到零。所以这个项目后来邀请第二个人进来，
 * 那个人若没有角色，**什么都看不到**——连通告都看不到。这正是「啥也没有」的字面意思：
 * 要协作就自己去权限中心配（给角色配键、或建部门配区间），配什么完全由项目自己决定。
 *
 * 模版只在建项目那一刻用一次，之后不参与任何判定，所以「一人项目长成三人项目」不需要
 * 换模版，只需要在配置中心加配置。
 */
import type { ProductionTemplate } from "../production-template";
import { PRODUCER_KEYS, policiesFromAnswers } from "./shared";

export const SOLO_TEMPLATE: ProductionTemplate = {
  key: "solo",
  label: "一人项目 / 其他（空模版）",
  roles: {
    names: ["制作人"],
    baseline: [],
    permissions: { 制作人: PRODUCER_KEYS },
  },
  deptTree: [],
  deptPermissions: {},
  cueTemplateTypes: [],
  cueDeclarations: [],
  /**
   * 全宽松。默认档里那几条「默认关」都是为**多人协作**设的保险——对外承诺性质的事件
   * 不该由创建者随手删、发布该由舞监把关。一人项目里这些保险没有保护对象，只会挡路：
   * 建错了自己删、写完了自己发。
   *
   * 任务归属选「收到即拥有」，其耦合项（失去宿主事件时的处置）因此是「留为孤儿」——
   * 一个人的项目里，系统不该自动清理他自己的东西。
   */
  policies: policiesFromAnswers({
    share_token: "yes",
    creator_publish_event: "yes",
    creator_delete_event: "yes",
    participant_list: "creator_only",
    report_creator_detach: "yes",
    task_ownership: "dept",
  }),
  approval: { ttlHours: 24 },
};
