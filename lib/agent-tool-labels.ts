// AI 工具调用的中文显示名。key 是去掉 "clickin__" 前缀后的暴露名
// （注册表 mcpName 的 "." 替换为 "-"，见 lib/agent-runtime/tools.ts exposedName）；tests/agent-tool-labels.test.ts
// 对照 lib/agent-runtime/tools.ts 的注册表防漂移——新增工具没配显示名会红。

const MCP_TOOL_PREFIX = "clickin__";

export const TOOL_LABELS: Record<string, string> = {
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
  "production-wiki_dialect_ref": "获取文档语法说明",
  "production-wiki_propose_create": "提议新建文档",
  "production-wiki_propose_update": "提议修改文档",
  "production-wiki_propose_delete": "提议删除文档",
  "production-wiki_propose_move": "提议移动文档",
  "production-wiki_propose_tag": "提议修改文档标签",
  "production-wiki_set_grant": "修改文档分享设置",
  "my-update_instructions": "更新个人 AI 指令",
  "production-update_instructions": "更新制作 AI 指令",
  "users-query_sensitive": "读取本人联系方式",
  "production-dramaturgy_permissions": "查询构作写权限",
  "production-scene_list": "浏览场次结构",
  "production-scene_read": "阅读场次构作",
  "production-character_list": "浏览角色列表",
  "production-character_read": "阅读角色小传",
  "production-scene_propose_update": "提议修改场次",
  "production-scene_propose_create": "提议新建场次",
  "production-scene_propose_delete": "提议删除场次",
  "production-character_propose_create": "提议新建角色",
  "production-character_propose_update": "提议修改角色",
  "production-character_propose_delete": "提议删除角色",
  "production-script_read_section": "阅读剧本段落",
  "production-script_read_window": "查看剧本上下文",
  "production-script_search": "搜索剧本台词",
  "production-script_read_page": "按页码读剧本",
  "production-script_dialect_ref": "获取剧本方言说明",
  "production-script_propose_rewrite": "提议改写剧本段落",
  "production-script_propose_edit_blocks": "提议修改剧本块",
  "my-schedules": "查看我的定时任务",
  "my-schedule_propose": "提议设置定时任务",
  // 运行时专属（不进 tool-catalog）
  "schedule-finish": "汇报定时任务结果",
  "ask_user": "向用户提问",
  "find_tools": "搜索可用工具",
  "web-search": "联网搜索",
  "web-fetch": "抓取网页",
};

/** 暴露名/原始名 → 中文显示名；没配的（未来新工具、gateway 内置工具）
 * 退回去前缀后的原名，绝不空白。 */
export function toolLabel(name: string): string {
  const bare = (name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name)
    .replace(/\./g, "-");
  return TOOL_LABELS[bare] ?? bare;
}
