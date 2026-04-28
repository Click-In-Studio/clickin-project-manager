import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "reply",
  description: "向触发消息的聊天（群聊或单聊）发送一条文本消息。",
  enabled: true,
  params: [
    { name: "text", type: "string", description: "要发送的消息内容", required: true },
  ],
};
