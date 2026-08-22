// 页面感知注册表：路由 → 页面标识（pageKey）→ 中文页面名 + 该页的 AI 建议。
//
// 设计原则（「主动就位、被动发言」）：系统只把「此刻能帮你什么」摆在手边——
// 建议 chip 点击仅填入输入框、绝不自动发送，页面信息只随用户下一条真实消息
// 的 <clickin-ui-context> 信封附带（可见、可摘除）。AI 永远不主动开口。
//
// PAGE_LABELS 是 **allowlist**：不在表里的路由不附带页面信息（宁可不带，也不
// 把原始 URL 片段送进模型——路径段是自由文本，走 allowlist 就无需净化）。
//
// 维护约定：每当某个页面对应的 MCP 工具上线（lib/mcp/server.ts），就回来给
// PAGE_SUGGESTIONS 加一行——建议必须诚实（背后真有工具能兑现），没有工具
// 支撑的页面只留 label 不留建议。

export type PageSuggestion = {
  /** chip 上显示的短标签 */
  label: string;
  /** 点击后填入输入框的建议 prompt（不自动发送——发言权始终在用户） */
  prompt: string;
};

/**
 * 路由 → pageKey。
 * - 项目内页面：`prod:<模块首段>`（项目首页为 `prod:home`）
 * - 个人页面：`my:<子页>`；全站首页 `home`；账号页 `account`
 * - 其余（login/share/invite/unauthorized 等）返回 null：不附带页面信息
 */
export function derivePageKey(pathname: string, productionId: string | null): string | null {
  if (productionId && pathname.startsWith(`/production/${productionId}`)) {
    const rest = pathname.slice(`/production/${productionId}`.length).replace(/^\//, "");
    if (!rest) return "prod:home";
    return `prod:${rest.split("/")[0]}`;
  }
  if (pathname === "/") return "home";
  if (pathname.startsWith("/my/")) {
    const sub = pathname.split("/")[2];
    return sub ? `my:${sub}` : null;
  }
  if (pathname === "/account" || pathname.startsWith("/account/")) return "account";
  return null;
}

/** pageKey → 中文页面名（allowlist，缺席 = 该页不附带页面信息）。 */
const PAGE_LABELS: Record<string, string> = {
  home: "首页",
  account: "账号设置",

  "my:projects": "我的项目",
  "my:tasks": "我的任务",
  "my:reqs": "我的需求",
  "my:reports": "我的报告",
  "my:notifications": "我的通知",
  "my:notification-settings": "通知设置",
  "my:announcements": "公告",
  "my:permissions": "我的权限",
  "my:daily-call": "每日通告",
  "my:weekly-call": "每周通告",

  "prod:home": "项目首页",
  "prod:script": "剧本",
  "prod:import-script": "剧本导入",
  "prod:import-scenes": "场次导入",
  "prod:dramaturgy": "戏剧构作",
  "prod:characters": "角色",
  "prod:wiki": "文档库",
  "prod:events": "事件",
  "prod:tasks": "任务",
  "prod:planning": "计划",
  "prod:cues": "Cue",
  "prod:cuelists": "Cue 列表",
  "prod:assets": "资产",
  "prod:materials": "物料",
  "prod:contacts": "人员通讯录",
  "prod:access-requests": "加入申请",
  "prod:reports": "报告",
  "prod:announcements": "项目公告",
  "prod:notifications": "项目通知",
  "prod:finance": "财务",
  "prod:admin": "管理后台",
};

/** pageKey → 该页的建议 prompt（仅收录已有 MCP 工具兑现的能力）。 */
const PAGE_SUGGESTIONS: Record<string, PageSuggestion[]> = {
  home: [
    { label: "我的制作", prompt: "我参与了哪些制作？各自是什么角色？" },
  ],
  "my:projects": [
    { label: "我的制作", prompt: "我参与了哪些制作？各自是什么角色？" },
  ],
  "my:reqs": [
    { label: "我的技术需求", prompt: "我名下有哪些技术需求？" },
  ],
  "my:daily-call": [
    { label: "我的通告", prompt: "我最近的通告时间安排是什么？" },
  ],
  "my:weekly-call": [
    { label: "我的通告", prompt: "我这周的通告时间安排是什么？" },
  ],
  "prod:home": [
    { label: "项目概况", prompt: "介绍一下这个项目的基本信息和最近的里程碑进展。" },
    { label: "我的通知", prompt: "这个项目里我有哪些未读通知？" },
  ],
  "prod:planning": [
    { label: "里程碑", prompt: "这个项目接下来的里程碑节点有哪些？" },
  ],
  "prod:wiki": [
    { label: "搜索文档", prompt: "帮我在文档库里找关于 …… 的内容。" },
    { label: "文档结构", prompt: "这个项目的文档库大致是怎么组织的？" },
  ],
  "prod:contacts": [
    { label: "查联系方式", prompt: "帮我查一下 …… 的联系方式。" },
    { label: "部门构成", prompt: "这个项目有哪些部门？各自负责人是谁？" },
  ],
  "prod:notifications": [
    { label: "未读通知", prompt: "这个项目里我有哪些未读通知？" },
  ],
};

export function pageLabelFor(pageKey: string | null): string | null {
  return pageKey ? PAGE_LABELS[pageKey] ?? null : null;
}

export function pageSuggestionsFor(pageKey: string | null): PageSuggestion[] {
  return pageKey ? PAGE_SUGGESTIONS[pageKey] ?? [] : [];
}

// 供 drift 测试用：PAGE_SUGGESTIONS 的 key 必须都在 PAGE_LABELS 里（有建议
// 却没有页面名 = 注册表自相矛盾）。
export const __registry = { PAGE_LABELS, PAGE_SUGGESTIONS };
