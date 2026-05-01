import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "get_my_mentions",
  description: `查询今天 @提及当前用户的所有 block 评论，返回评论内容、所在 block、作者及时间。
需要已聚焦的 production context。`,
  enabled: true,
  mode: "sync",
  params: [],
  pendingMessage: "正在查询今天 @我 的评论…",
  constrain: (r) => ({ ...r, wait_reply: false }),
};
