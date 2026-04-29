import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "focus_production",
  description: `向用户展示 production 候选列表，由用户点击卡片按钮确认。确认后 production 将成为当前 context，持续作用于后续操作。
调用时机：
1. 需要针对特定 production 执行任务，但当前 context 中 production 未设置
2. 上下文暗示用户在讨论另一个 production（如"换一个 production"、"另一个剧目"）
candidates 由你根据上下文推断，若不确定可先调用 get_productions 获取可见列表。
必须配合 wait_reply:true 使用（系统会强制执行）。`,
  enabled: true,
  mode: "sync" as const,
  params: [
    {
      name: "candidates",
      type: "Array<{name: string}>",
      description: "你推断的 production 候选名称列表，至少 1 个，建议不超过 5 个。不需要提供 ID，系统会自动从数据库解析",
      required: true,
    },
  ],
};
