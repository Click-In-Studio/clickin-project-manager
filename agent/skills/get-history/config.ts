import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "get_history",
  description: "从飞书 API 获取当前聊天的近期消息记录。当需要了解更多聊天背景、查找之前对话内容时调用。结果注入上下文后可继续处理，也可挂起等待用户确认。",
  enabled: true,
  mode: "async" as const,
  pendingMessage: "正在获取聊天记录，请稍候…",
  params: [
    {
      name: "count",
      type: "number",
      description: "要获取的消息条数，默认 10，最多 50",
      required: false,
    },
  ],
};
