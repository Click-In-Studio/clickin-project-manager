import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "list_skills",
  description: "获取所有可用扩展技能的完整列表（含说明和参数），然后根据需要调用对应技能。当你判断完成任务需要某种额外能力（如查询历史记录、获取卡片内容等）但主要技能无法满足时调用。",
  enabled: true,
  params: [],
  constrain: (response) => response.wait_reply ? { ...response, wait_reply: false } : response,
};
