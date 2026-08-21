// AI 工具调用的中文显示名。key 是去掉 "clickin__" 前缀后的暴露名
// （MCP 原始名的 "." 在插件暴露时被替换为 "-"，见 openclaw-plugins/
// clickin-memory 的 MCP_TOOL_PREFIX 注释）；tests/agent-tool-labels.test.ts
// 对照 lib/mcp/server.ts 的注册清单防漂移——新增工具没配显示名会红。

const MCP_TOOL_PREFIX = "clickin__";

export const TOOL_LABELS: Record<string, string> = {
  "approvals-list": "查看待审批请求",
  "my-call_times": "查询我的 Call 时间",
  "my-tech_reqs": "查询我的技术需求",
  "my-events": "查询我关注的活动",
  "my-milestones": "查询临近里程碑",
  "my-productions": "查询我参与的制作",
  "my-memory_search": "检索我的记忆",
  "production-info": "查询制作详情",
  "production-my_role": "查询我的职位信息",
  "production-notifications": "查询我的通知",
  "production-milestones": "查询制作里程碑",
  "production-contact_list": "查询成员名单",
  "production-department_list": "查询部门结构",
  "production-wiki_tree": "浏览文档树",
  "production-wiki_backlinks": "查询文档链接关系",
  "production-wiki_read": "阅读文档",
  "production-wiki_search": "搜索文档",
  "production-wiki_propose_create": "提议新建文档",
  "production-wiki_propose_update": "提议修改文档",
  "production-wiki_propose_delete": "提议删除文档",
  "production-wiki_propose_move": "提议移动文档",
  "production-wiki_propose_tag": "提议修改文档标签",
  "production-wiki_set_grant": "修改文档分享设置",
  "my-update_instructions": "更新个人 AI 指令",
  "production-update_instructions": "更新制作 AI 指令",
  "users-query_sensitive": "读取本人联系方式",
};

/** 暴露名/原始名 → 中文显示名；没配的（未来新工具、gateway 内置工具）
 * 退回去前缀后的原名，绝不空白。 */
export function toolLabel(name: string): string {
  const bare = (name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name)
    .replace(/\./g, "-");
  return TOOL_LABELS[bare] ?? bare;
}
