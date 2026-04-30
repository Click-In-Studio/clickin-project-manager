import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "get_daily_call",
  description: `查询当前用户某日的集合时间（Daily Call）列表，包含事件名称、地点、流程单概览。
日期默认为今天（CST），可通过 date 参数指定具体日期。
不需要 production context，直接查询当前用户名下所有 production。`,
  enabled: true,
  mode: "sync" as const,
  pendingMessage: "正在查询 Call 时间…",
  params: [
    {
      name: "date",
      type: "string",
      description: "查询日期，格式 YYYY-MM-DD（CST），默认今天",
      required: false,
    },
  ],
  constrain: (response) => response.wait_reply ? { ...response, wait_reply: false } : response,
};
