export const CREATION_NAV = [
  { label: "构作", hint: "构作视图 · 角色 · 灵感文档", path: "dramaturgy", icon: "dramaturgy" },
  { label: "剧本", hint: "阅读 · 编辑 · 讨论", path: "script", icon: "script" },
  { label: "Cue", hint: "部门执行设计", path: "cues", icon: "cue" },
] as const;

export const PRODUCTION_NAV = [
  { label: "人员", hint: "演员 · 部门 · 团队", path: "contacts", icon: "person" },
  { label: "计划与日程", hint: "日历 · 甘特 · 执行表", path: "planning", icon: "calendar" },
  { label: "事件", hint: "围读 · 排练 · 演出", path: "events", icon: "event" },
  { label: "任务", hint: "技术需求 · 跟进", path: "tasks", icon: "task" },
  { label: "报告", hint: "演出报告 · 归档", path: "reports", icon: "report" },
  { label: "云文档", hint: "文档·文件一棵树", path: "wiki", icon: "knowledge" },
  { label: "财务", hint: "预算 · 支出 · 关联", path: "finance", icon: "finance" },
  { label: "物料", hint: "道具 · 服装 · 设备", path: "materials", icon: "material" },
  { label: "资产工作台", hint: "上传 · 清单 · 文件治理", path: "assets", icon: "asset" },
] as const;

export const PRODUCTION_OVERVIEW_NAV = [
  { label: "我的工作", hint: "今天与我有关", path: "", icon: "home", activeModules: [""] },
  { label: "我的通知", hint: "项目公告 · 个人通知", path: "notifications", icon: "notification", activeModules: ["notifications", "announcements"] },
  { label: "审批", hint: "待处理 · 我的申请", path: "access-requests", icon: "approval", activeModules: ["access-requests"] },
] as const;

// feature 标的是**付费档位**依赖（#280），不是权限：带 feature 的项在档位没开通该功能
// 的项目里整条不出现在菜单里。权限维度（canAdmin）管的是能不能进管理面板本身，两者正交。
type AdminNavItem = { label: string; hint: string; path: string; icon: "announcement" | "approval-flow" | "asset-review" | "audit" | "danger" | "finance" | "migration" | "milestone" | "organization" | "overview" | "permissions" | "policies" | "producer" | "project-info" | "roles" | "templates"; feature?: "advancedPerms"; scope?: "admin" | "finance" | "approvalFlows" };

export const ADMIN_NAV_GROUPS: { title: string | null; items: AdminNavItem[] }[] = [
  {
    title: null,
    items: [
      { label: "项目概览", hint: "基础数据 · 一览", path: "", icon: "overview" },
    ],
  },
  {
    title: "业务配置",
    items: [
      { label: "财务设置", hint: "费用科目 · 部门预算", path: "finance", icon: "finance", scope: "finance" },
    ],
  },
  {
    title: "项目发布",
    items: [
      { label: "里程碑", hint: "阶段 · 节点", path: "milestones", icon: "milestone" },
      { label: "公告管理", hint: "发布 · 置顶 · 已读", path: "announcements", icon: "announcement" },
    ],
  },
  {
    title: "组织架构",
    items: [
      { label: "成员与部门", hint: "邀请 · 归属 · POC", path: "organization", icon: "organization" },
      { label: "角色管理", hint: "职称 · 系统角色", path: "roles", icon: "roles" },
    ],
  },
  {
    title: "安全设置",
    items: [
      { label: "权限中心", hint: "部门 · 角色 · 人事", path: "permissions", icon: "permissions", feature: "advancedPerms" },
      { label: "访问审批流程", hint: "权限申请 · 流程模版", path: "approval-flows", icon: "approval-flow", scope: "approvalFlows" },
      { label: "权限模版", hint: "Cue 表模版", path: "templates", icon: "templates" },
      { label: "策略中心", hint: "Policy 配置", path: "policies", icon: "policies", feature: "advancedPerms" },
    ],
  },
  {
    title: "合规",
    items: [
      { label: "权限审计", hint: "授权流水 · 撤销", path: "audit", icon: "audit" },
      { label: "数字资产审查", hint: "越隐私管理", path: "asset-review", icon: "asset-review" },
    ],
  },
  {
    title: "项目设置",
    items: [
      { label: "项目信息", hint: "名称 · 简介 · 外观", path: "settings", icon: "project-info" },
      { label: "管理员设置", hint: "制作人权限 · 人事", path: "producer", icon: "producer" },
      { label: "数据迁移", hint: "剧本 · 构作 · 导入", path: "migration", icon: "migration" },
      { label: "危险操作", hint: "归档 · 转让 · 删除", path: "danger", icon: "danger" },
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
  { label: "公告", hint: "演出公告与风险提醒", path: "/my/announcements", icon: "announcement" },
  { label: "日程", hint: "完整 Weekly Call", path: "/my/weekly-call", icon: "calendar" },
  { label: "任务", hint: "需求 · 跟进 · 完成", path: "/my/tasks", icon: "task" },
  { label: "通知提醒", hint: "确认与告知", path: "/my/notifications", icon: "notification" },
  { label: "报告", hint: "所有演出报告", path: "/my/reports", icon: "report" },
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
  wiki: "云文档",
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
