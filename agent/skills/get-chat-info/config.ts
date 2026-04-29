import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "get_chat_info",
  description: "获取当前聊天的详细信息：聊天名称、成员总数、群主、管理员、成员列表（最多 100 人）。群聊场景下可用于了解群组构成、确认权限归属等。",
  enabled: true,
  mode: "async" as const,
  pendingMessage: "正在获取聊天信息，请稍候…",
  params: [],
};
