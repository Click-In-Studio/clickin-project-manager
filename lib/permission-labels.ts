import type { Permission } from "./permissions";

// 批A 起同时容纳原子键与树节点键（node:<type>/<id>[/<sub>]@<verb>）
export const PERMISSION_LABELS: Partial<Record<Permission, string>> & Record<string, string> = {
  // ── 树节点键（cue 域，批A）──
  "node:cue_list/*/meta@view": "查看Cue表目录",
  "node:cue_list/*/cues@view": "查看Cue表内容",
  "node:cue_list/*/cues/comments@create": "评论Cue",
  "node:cue_list/*@create": "创建Cue表",
  // ── 树节点键（event/task 域，批B）──
  "node:event/*/meta@view": "查看事件目录",
  "node:event/*/details@view": "查看事件详情",
  "node:event/*/followers@create": "关注事件",
  "node:event/*@create": "创建事件",
  "node:event/*/chat@create": "事件群聊",
  "node:event/*/call_sheet@view": "查看他人Call Sheet",
  "node:task/*@view": "查看全部任务",
  "node:task/*@delete": "删除任务",
  // ── 树节点键（report 域，批C）──
  "node:event/*/reports@create": "创建报告",
  "node:report/*/replies@create": "回复报告",
  "node:report/*/replies@edit": "编辑他人报告评论",
  "node:report/*/replies@delete": "删除他人报告评论",
  // 项目管理
  // 通讯录
  // 成员管理
  // 职位管理
  // 部门管理
  // 剧本
  // 章节/段落
  // 角色
  // 剧本标签
  // Cue表
  // 构作
  // 事件（per-event 写操作已迁移至 resource_grant，原子权限只保留生产级和管理员绕过）
  // Task（技术需求，per-task 写操作已迁移至 resource_grant）
  // 报告（per-report 写操作已迁移至 resource_grant，保留生产级和管理员绕过）
  // 数字资产
  // 组织
  "org:assign_member": "分配组织成员",
  "org:recall_member": "收回组织成员",
  // 里程碑
  // 公告
};

export const GROUP_LABELS: Record<string, string> = {
  production: "项目管理",
  contacts: "通讯录",
  members: "成员管理",
  role: "职位管理",
  dept: "部门管理",
  script: "剧本",
  rehearsal_mark: "排练记号",
  scene: "章节/段落",
  character: "角色",
  tag_group: "剧本标签组",
  tag_option: "剧本标签",
  cue_list: "Cue表",
  cue: "Cue",
  dramaturgy: "构作",
  dramaturgy_view: "构作视图",
  event: "事件",
  task: "任务",
  report: "报告",
  asset: "数字资产",
  org: "组织",
  milestone: "里程碑",
  announcement: "公告",
};

/** 键的分组前缀：原子键取 ':' 前段，节点键取资源类型段 */
export function permissionGroupPrefix(key: string): string {
  if (key.startsWith("node:")) return key.slice(5).split("/")[0] ?? key;
  return key.split(":")[0] ?? key;
}

/** Deduplicated category labels for a list of permission keys */
export function permissionCategories(perms: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of perms) {
    const prefix = permissionGroupPrefix(p);
    const label = GROUP_LABELS[prefix] ?? prefix;
    if (!seen.has(label)) {
      seen.add(label);
      result.push(label);
    }
  }
  return result;
}
