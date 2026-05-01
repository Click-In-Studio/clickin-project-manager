import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "get_block_by_id",
  description: `读取剧本中指定 block ID 的内容，返回该块的行号、类型、角色、场景和台词/舞台提示文本。
需要已聚焦的 production context，否则请先调用 focus_production。`,
  enabled: true,
  mode: "sync",
  params: [
    {
      name: "block_id",
      type: "string",
      description: "目标 block 的 UUID（如从搜索结果或其他技能中获得）",
      required: true,
    },
  ],
  pendingMessage: (a) => {
    const id = (a as { block_id?: string })?.block_id;
    return id ? `正在读取 Block ${id}…` : "正在读取台词块…";
  },
  constrain: (r) => ({ ...r, wait_reply: false }),
};
