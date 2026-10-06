export const CREATION_NAV = [
  { label: "构作", hint: "构作视图 · 角色 · 灵感文档", path: "dramaturgy", symbol: "构" },
  { label: "剧本", hint: "阅读 · 编辑 · 讨论", path: "script", symbol: "剧" },
  { label: "Cue", hint: "部门执行设计", path: "cues", symbol: "Q" },
] as const;

export const PRODUCTION_NAV = [
  { label: "人员", hint: "演员 · 部门 · 团队", path: "contacts", symbol: "人" },
  { label: "计划与日程", hint: "日历 · 甘特 · 执行表", path: "planning", symbol: "计" },
  { label: "事件", hint: "围读 · 排练 · 演出", path: "events", symbol: "事" },
  { label: "任务", hint: "技术需求 · 跟进", path: "tasks", symbol: "任" },
  { label: "报告", hint: "演出报告 · 归档", path: "reports", symbol: "报" },
  { label: "知识库", hint: "wiki · 文档与资产一棵树", path: "wiki", symbol: "知" },
  { label: "财务", hint: "预算 · 支出 · 关联", path: "finance", symbol: "财" },
  { label: "物料", hint: "道具 · 服装 · 设备", path: "materials", symbol: "物" },
  { label: "资产工作台", hint: "上传 · 清单 · 文件治理", path: "assets", symbol: "资" },
] as const;

export const PRODUCTION_OVERVIEW_NAV = [
  { label: "我的工作", hint: "今天与我有关", path: "", symbol: "⌂", activeModules: [""] },
  { label: "我的通知", hint: "项目公告 · 个人通知", path: "notifications", symbol: "◉", activeModules: ["notifications", "announcements"] },
  { label: "审批", hint: "待处理 · 我的申请", path: "access-requests", symbol: "◑", activeModules: ["access-requests"] },
] as const;

// feature 标的是**付费档位**依赖（#280），不是权限：带 feature 的项在档位没开通该功能
// 的项目里整条不出现在菜单里。权限维度（canAdmin）管的是能不能进管理面板本身，两者正交。
export const ADMIN_NAV_GROUPS: { title: string | null; items: { label: string; hint: string; path: string; feature?: "advancedPerms"; scope?: "admin" | "finance" | "approvalFlows" }[] }[] = [
  {
    title: null,
    items: [
      { label: "项目概览", hint: "基础数据 · 一览", path: "" },
    ],
  },
  {
    title: "业务配置",
    items: [
      { label: "财务设置", hint: "费用科目 · 部门预算", path: "finance", scope: "finance" },
    ],
  },
  {
    title: "项目发布",
    items: [
      { label: "里程碑", hint: "阶段 · 节点", path: "milestones" },
      { label: "公告管理", hint: "发布 · 置顶 · 已读", path: "announcements" },
    ],
  },
  {
    title: "组织架构",
    items: [
      { label: "成员与部门", hint: "邀请 · 归属 · POC", path: "organization" },
      { label: "角色管理", hint: "职称 · 系统角色", path: "roles" },
    ],
  },
  {
    title: "安全设置",
    items: [
      { label: "权限中心", hint: "部门 · 角色 · 人事", path: "permissions", feature: "advancedPerms" },
      { label: "访问审批流程", hint: "权限申请 · 流程模版", path: "approval-flows", scope: "approvalFlows" },
      { label: "权限模版", hint: "Cue 表模版", path: "templates" },
      { label: "策略中心", hint: "Policy 配置", path: "policies", feature: "advancedPerms" },
    ],
  },
  {
    title: "合规",
    items: [
      { label: "权限审计", hint: "授权流水 · 撤销", path: "audit" },
      { label: "数字资产审查", hint: "越隐私管理", path: "asset-review" },
    ],
  },
  {
    title: "项目设置",
    items: [
      { label: "项目信息", hint: "名称 · 简介 · 外观", path: "settings" },
      { label: "管理员设置", hint: "制作人权限 · 人事", path: "producer" },
      { label: "数据迁移", hint: "剧本 · 构作 · 导入", path: "migration" },
      { label: "危险操作", hint: "归档 · 转让 · 删除", path: "danger" },
    ],
  },
];

export function adminTopMenuLabel(path: string): string | null {
  for (const group of ADMIN_NAV_GROUPS) {
    const item = group.items.find((candidate) => candidate.path === path);
    if (item) return item.label;
  }
  return null;
}

export const OVERVIEW_NAV = [
  { label: "公告", hint: "演出公告与风险提醒", path: "/my/announcements", symbol: "⊟" },
  { label: "日程", hint: "完整 Weekly Call", path: "/my/weekly-call", symbol: "◷" },
  { label: "任务", hint: "需求 · 跟进 · 完成", path: "/my/tasks", symbol: "✓" },
  { label: "通知提醒", hint: "确认与告知", path: "/my/notifications", symbol: "◉" },
  { label: "报告", hint: "所有演出报告", path: "/my/reports", symbol: "≡" },
] as const;

export const PRODUCTION_TOP_MENU_LABELS: Record<string, string> = {
  "": "我的工作",
  notifications: "我的通知",
  announcements: "我的通知",
  "access-requests": "审批",
  script: "剧本",
  dramaturgy: "构作",
  characters: "构作",
  cues: "Cue",
  cuelists: "Cue 表设置",
  contacts: "人员",
  planning: "计划与日程",
  events: "事件",
  tasks: "任务",
  reports: "报告",
  wiki: "知识库",
  finance: "财务",
  materials: "物料",
  assets: "资产工作台",
};

export const PLATFORM_TOP_MENU_LABELS: Record<string, string> = {
  "/": "我的工作",
  "/my/projects": "我的项目",
  "/my/announcements": "公告与风险提醒",
  "/my/weekly-call": "本周日程",
  "/my/daily-call": "当日 Call Sheet",
  "/my/tasks": "我的任务",
  "/my/notifications": "通知提醒",
  "/my/reports": "报告",
  "/account": "个人中心",
};
