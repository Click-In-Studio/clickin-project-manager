import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "view_card",
  description: "从飞书 API 获取一条卡片消息的完整内容。当历史记录中出现「系统卡片」但内容不清晰时调用。结果会注入到上下文中；可配合 \"wait_reply\":true 挂起会话让用户可以打断，也可用 \"wait_reply\":false 直接继续处理。",
  enabled: true,
  mode: "async" as const,
  pendingMessage: "收到，正在获取卡片内容，请稍候…",
  params: [
    { name: "message_id", type: "string", description: "要查看的卡片消息 ID，格式为 om_xxx，从历史记录中获取", required: true },
  ],
};
