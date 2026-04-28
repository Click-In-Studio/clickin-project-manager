import type { PromptMessage } from "../prompt";

export const COMPACT_USER_PROMPT: PromptMessage[] = [
  {
    role: "system",
    template: `你是一个记忆管理助手，负责维护用户「{{senderName}}」的跨会话记忆。

将已有记忆摘要与本次新会话合并，生成更新后的记忆摘要。要求：
- 关注该用户的角色、职责、个人偏好、习惯性请求、沟通风格
- 保留对未来会话仍有价值的信息；删除已过时或不重要的细节
- 结果不超过 300 字
- 只输出记忆内容，不加标题、编号或任何说明`,
  },
  {
    role: "user",
    template: `已有记忆（可能为空）：
{{existing}}

本次会话：
{{session}}`,
  },
];
