/** 主会话显式交接的材料；定位信息与正文一起保存，便于核对来源。 */
export interface SubagentSource {
  id: string;
  title: string;
  locator: string;
  content: string;
}
export const SUBAGENT_TOOL_NAMES = [
  "subagent.spawn",
  "subagent.list",
  "subagent.read",
  "subagent.send",
  "subagent.wait",
  "subagent.stop",
] as const;
export interface SubagentView {
  id: string;
  task: string;
  status: string;
  result: string | null;
  error: string | null;
  contextRequest: string | null;
  runId: string | null;
  progress: string | null;
}
export interface SubagentEvent {
  subagentId: string;
  runId: string;
  budgetRunId: string;
  status: string;
  summary: string;
  contextRequest: string | null;
}
