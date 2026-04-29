import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "set_task_anchor",
  description: "设置、更新或清除当前任务锚点。任务锚点记录本次对话的核心任务类型、主题和目标，是使用大多数其他技能的前提条件。每次开始新任务或任务完成后应主动维护锚点。",
  mode: "sync",
  params: [
    {
      name: "action",
      type: '"set" | "clear"',
      required: true,
      description: "set = 设置/更新锚点；clear = 清除锚点（任务完成或明确终止时使用）",
    },
    {
      name: "type",
      type: '"creative_discussion" | "event_query" | "data_update" | "unknown"',
      required: false,
      description: "action=set 时必填。creative_discussion=创意/规划讨论，event_query=事件数据查询，data_update=数据修改/录入，unknown=意图尚不明确",
    },
    {
      name: "subject",
      type: "string",
      required: false,
      description: "action=set 时必填。任务主题，简短描述核心对象（如「《星星》演出的排练安排」）",
    },
    {
      name: "goal",
      type: "string",
      required: false,
      description: "action=set 时必填。本次任务的具体目标（如「查询下周排练的集合时间」）",
    },
    {
      name: "status",
      type: '"active" | "paused" | "completed"',
      required: false,
      description: "action=set 时必填。active=进行中，paused=已暂停，completed=已完成",
    },
    {
      name: "confidence",
      type: "number",
      required: false,
      description: "action=set 时必填。对任务意图理解的置信度，0.0–1.0（低于 0.7 时应先 reply 澄清再设置）",
    },
  ],
};
