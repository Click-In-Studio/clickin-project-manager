import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "query_events",
  description: `查询当前 production 下的演出事件列表。支持多条件组合过滤。
需要已聚焦的 production context，否则请先调用 focus_production。
返回符合条件的事件摘要（最多 50 条），包含基本信息和舞台监督。`,
  enabled: true,
  mode: "sync" as const,
  params: [
    {
      name: "filters",
      type: `{
  status?: Array<"draft"|"published"|"completed"|"cancelled">,
  dateFrom?: string,          // YYYY-MM-DD（北京时间，含）
  dateTo?: string,            // YYYY-MM-DD（北京时间，含）
  title?: string,             // 事件名称模糊匹配
  eventType?: Array<"rehearsal"|"performance"|"meeting"|"custom">,
  participantName?: string,   // 参与人员名称模糊匹配
  techReqKeyword?: string     // 技术需求标题/描述关键词模糊匹配
}`,
      description: `过滤条件，所有字段均可选，多条件取交集。空对象 {} 表示获取所有事件。
status 枚举：draft（草稿）| published（已发布）| completed（已完成）| cancelled（已取消）
eventType 枚举：rehearsal（排练）| performance（演出）| meeting（会议）| custom（其他）`,
      required: true,
    },
  ],
  constrain: (response) => response.wait_reply ? { ...response, wait_reply: false } : response,
};
