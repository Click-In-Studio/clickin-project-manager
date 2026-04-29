import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "get_productions",
  description: "获取当前对话参与者均有权限访问的 production 列表。群聊中会取所有已知成员权限的交集，确保返回的 production 对所有人可见。P2P 中仅基于发送者权限。",
  enabled: true,
  mode: "async" as const,
  pendingMessage: "正在查询 production，请稍候…",
  params: [],
};
