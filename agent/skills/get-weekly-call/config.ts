import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "get_weekly_call",
  description: `查询当前用户未来 7 天的集合时间（Weekly Call）列表，按日期分组显示。
不需要 production context，直接查询当前用户名下所有 production。`,
  enabled: true,
  mode: "sync" as const,
  params: [],
  constrain: (response) => response.wait_reply ? { ...response, wait_reply: false } : response,
};
