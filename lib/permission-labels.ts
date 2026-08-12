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
  "production:delete": "删除项目",
  "production:transfer_owner": "转让所有权",
  "production:restore_checkpoint": "恢复检查点",
  "production:archive": "归档/取消归档项目",
  "production:rename": "重命名项目",
  "production:change_type": "修改项目类型",
  "production:manage_integrations": "管理第三方集成",
  "production:import_members": "批量导入成员",
  "production:producer_invite": "邀请制作人",
  "production:producer_promote": "提升为制作人",
  "production:producer_demote": "降级制作人",
  "production:producer_kick": "移除制作人",
  "production:manage_config": "管理项目配置",
  "production:mount": "挂载附件到项目",
  "production:unmount": "从项目移除挂载",
  "production:change_avatar": "修改项目头像",
  "production:edit_description": "编辑项目描述",
  "production:change_language": "修改项目语言",
  // 通讯录
  "contacts:import": "导入/更新通讯录",
  "contacts:view": "查看通讯录",
  // 成员管理
  "members:invite": "邀请成员",
  "members:kick": "移除成员",
  "members:change_role": "修改成员角色",
  "members:manage_overrides": "管理权限覆盖",
  // 职位管理
  "role:create": "创建职位",
  "role:rename": "重命名职位",
  "role:delete": "删除职位",
  "role:assign_permission": "分配职位权限",
  // 部门管理
  "dept:create": "创建部门",
  "dept:dismiss": "解散部门",
  "dept:rename": "重命名部门",
  "dept:change_type": "修改部门类型",
  "dept:add_member": "添加部门成员",
  "dept:delete_member": "移除部门成员",
  "dept:set_poc": "设置部门负责人",
  "dept:unset_poc": "取消部门负责人",
  // 剧本
  "script:import": "导入剧本",
  "script:manage": "剧本管理",
  "script:edit": "编辑剧本文本",
  "script:annotate": "添加剧本批注",
  "script:view": "查看剧本",
  "script:comment": "剧本评论",
  "script:edit_comment_any": "编辑他人剧本评论",
  "script:delete_comment_any": "删除他人剧本评论",
  "rehearsal_mark:create": "创建排练记号",
  "rehearsal_mark:edit": "编辑排练记号",
  "rehearsal_mark:delete": "删除排练记号",
  "rehearsal_mark:move": "移动排练记号",
  "script:create_block": "创建剧本块",
  "script:delete_block": "删除剧本块",
  "script:edit_block": "编辑剧本块",
  "script:set_character": "设置台词角色",
  "script:set_type": "设置块类型",
  "script:set_tag": "设置块标签",
  "script:reorder": "调整剧本顺序",
  "script:mount": "挂载剧本附件",
  // 章节/段落
  "scene:create": "创建章节/段落",
  "scene:delete": "删除章节/段落",
  "scene:rename": "重命名章节/段落",
  "scene:renumber": "重新编号章节/段落",
  "scene:change_type": "修改章节/段落类型",
  "scene:edit_synopsis": "修改章节/段落简介",
  "scene:edit_action_line": "编辑行动线",
  "scene:edit_music": "编辑章节/段落音乐",
  "scene:edit_stage_notes": "编辑舞台呈现",
  "scene:edit_expected_duration": "编辑预计时长",
  "scene:mount": "挂载章节/段落附件",
  "scene:view": "查看章节/段落",
  // 角色
  "character:delete": "删除角色",
  "character:create": "创建角色",
  "character:rename": "重命名角色",
  "character:change_type": "修改角色类型",
  "character:set_members": "设置聚合角色",
  "character:edit_gender": "编辑角色性别",
  "character:edit_biography": "编辑人物小传",
  "character:edit_role_type": "编辑角色类型",
  "character:view": "查看角色",
  // 剧本标签
  "tag_group:create": "创建剧本标签组",
  "tag_group:delete": "删除剧本标签组",
  "tag_group:rename": "重命名剧本标签组",
  "tag_group:edit_range_config": "编辑标签范围配置",
  "tag_group:set_default_option": "设置默认标签选项",
  "tag_group:set_lyric_split": "设置歌词拆分",
  "tag_group:reorder": "排序剧本标签组",
  "tag_option:create": "创建剧本标签",
  "tag_option:delete": "删除剧本标签",
  "tag_option:rename": "重命名剧本标签",
  "tag_option:edit_color": "编辑标签颜色",
  "tag_option:reorder": "排序剧本标签",
  // Cue表
  // 构作
  "dramaturgy:import": "导入构作数据",
  "dramaturgy_view:create_public": "创建公开构作视图",
  "dramaturgy_view:delete_public": "删除公开构作视图",
  "dramaturgy_view:overwrite_public": "覆盖公开构作视图",
  "dramaturgy_view:create": "创建构作视图",
  "dramaturgy_view:delete": "删除构作视图",
  "dramaturgy_view:overwrite": "覆盖构作视图",
  // 事件（per-event 写操作已迁移至 resource_grant，原子权限只保留生产级和管理员绕过）
  // Task（技术需求，per-task 写操作已迁移至 resource_grant）
  // 报告（per-report 写操作已迁移至 resource_grant，保留生产级和管理员绕过）
  // 数字资产
  // 组织
  "org:assign_member": "分配组织成员",
  "org:recall_member": "收回组织成员",
  // 里程碑
  "milestone:create": "创建里程碑",
  "milestone:manage": "管理里程碑",
  "milestone:delete": "删除里程碑",
  // 公告
  "announcement:create": "创建公告",
  "announcement:edit": "编辑公告",
  "announcement:delete": "删除公告",
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
