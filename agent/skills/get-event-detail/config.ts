import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "get_event_detail",
  description: `获取单个演出事件的完整详情，包括流程单、参与人员及集合时间、技术需求、演出报告。
需要已聚焦的 production context，否则请先调用 focus_production。
event_id 可通过 query_events 获取。`,
  enabled: true,
  mode: "sync" as const,
  pendingMessage: "正在查询事件详情…",
  params: [
    {
      name: "event_id",
      type: "string",
      description: "事件 ID（UUID），可从 query_events 结果中获取",
      required: true,
    },
  ],
  constrain: (response) => response.wait_reply ? { ...response, wait_reply: false } : response,
};
