import type { SkillConfig } from "../_types";

export const config: SkillConfig = {
  name: "get_my_tech_reqs",
  description: `查询当前用户负责的未完成技术需求，包含：
- 作为 assignee（负责人）的未完成需求
- 作为部门 POC 且状态为 awaiting 的需求
不需要 production context，覆盖所有 production。`,
  enabled: true,
  mode: "sync" as const,
  pendingMessage: "正在查询技术需求…",
  params: [],
  constrain: (response) => response.wait_reply ? { ...response, wait_reply: false } : response,
};
