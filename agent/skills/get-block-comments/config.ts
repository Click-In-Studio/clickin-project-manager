import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "get_block_comments",
  description: `读取指定 block 上的所有评论，返回评论内容、作者、时间及 @提及列表。
需要已聚焦的 production context。`,
  enabled: true,
  mode: "sync",
  params: [
    {
      name: "block_id",
      type: "string",
      description: "目标 block 的 UUID",
      required: true,
    },
  ],
  pendingMessage: (a) => {
    const id = (a as { block_id?: string })?.block_id;
    return id ? `正在读取 Block ${id} 的评论…` : "正在读取评论…";
  },
  constrain: (r) => ({ ...r, wait_reply: false }),
};
