"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import { ALL_PERMISSIONS, type Permission } from "@/lib/permissions";

const PERMISSION_LABELS: Partial<Record<Permission, string>> = {
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
  "dept:set_poc": "设置部门联系人",
  "dept:unset_poc": "取消部门联系人",
  // 剧本
  "script:import": "导入剧本",
  "script:manage": "剧本高级编辑",
  "script:edit": "剧本文本编辑",
  "script:annotate": "剧本排练记号",
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
  "script:set_tag": "设置标注",
  "script:reorder": "调整剧本顺序",
  "script:mount": "挂载剧本附件",
  // 场次
  "scene:create": "创建场次",
  "scene:delete": "删除场次",
  "scene:rename": "重命名场次",
  "scene:renumber": "重新编号场次",
  "scene:change_type": "修改场次类型",
  "scene:edit_synopsis": "编辑场次概要",
  "scene:edit_action_line": "编辑动作线",
  "scene:edit_music": "编辑场次音乐",
  "scene:edit_stage_notes": "编辑舞台提示",
  "scene:edit_expected_duration": "编辑预计时长",
  "scene:mount": "挂载场次附件",
  "scene:view": "查看场次",
  // 角色
  "character:delete": "删除角色",
  "character:create": "创建角色",
  "character:rename": "重命名角色",
  "character:change_type": "修改角色类型",
  "character:set_members": "设置角色扮演者",
  "character:edit_gender": "编辑角色性别",
  "character:edit_biography": "编辑角色小传",
  "character:edit_role_type": "编辑角色定位",
  "character:view": "查看角色",
  // 标注体系
  "tag_group:create": "创建标注组",
  "tag_group:delete": "删除标注组",
  "tag_group:rename": "重命名标注组",
  "tag_group:edit_range_config": "编辑标注范围配置",
  "tag_group:set_default_option": "设置默认标注选项",
  "tag_group:set_lyric_split": "设置歌词拆分",
  "tag_group:reorder": "排序标注组",
  "tag_option:create": "创建标注选项",
  "tag_option:delete": "删除标注选项",
  "tag_option:rename": "重命名标注选项",
  "tag_option:edit_color": "编辑标注颜色",
  "tag_option:reorder": "排序标注选项",
  // Cue表
  "cue_list:create_any": "创建任意Cue表",
  "cue_list:delete_any": "删除任意Cue表",
  "cue_list:rename_any": "重命名任意Cue表",
  "cue_list:reorder_any": "排序任意Cue表",
  "cue_list:edit_abbr_any": "编辑任意Cue表缩写",
  "cue_list:edit_description_any": "编辑任意Cue表说明",
  "cue_list:manage_permissions_any": "管理任意Cue表权限",
  "cue_list:create": "创建Cue表",
  "cue_list:delete": "删除Cue表",
  "cue_list:rename": "重命名Cue表",
  "cue_list:reorder": "排序Cue表",
  "cue_list:edit_abbr": "编辑Cue表缩写",
  "cue_list:edit_description": "编辑Cue表说明",
  "cue_list:manage_permissions": "管理Cue表权限",
  "cue_list:view": "查看Cue表",
  "cue:create_any": "创建任意Cue",
  "cue:delete_any": "删除任意Cue",
  "cue:renumber_any": "重新编号任意Cue",
  "cue:rename_any": "重命名任意Cue",
  "cue:edit_description_any": "编辑任意Cue说明",
  "cue:move_any": "移动任意Cue",
  "cue:mount_any": "挂载任意Cue附件",
  "cue:create": "创建Cue",
  "cue:delete": "删除Cue",
  "cue:renumber": "重新编号Cue",
  "cue:rename": "重命名Cue",
  "cue:edit_description": "编辑Cue说明",
  "cue:move": "移动Cue",
  "cue:mount": "挂载Cue附件",
  "cue:view": "查看Cue",
  "cue:comment": "评论Cue",
  "cue:edit_comment_any": "编辑他人Cue评论",
  "cue:delete_comment_any": "删除他人Cue评论",
  // 构作
  "dramaturgy:import": "导入构作数据",
  "dramaturgy_view:create_public": "创建公开构作视图",
  "dramaturgy_view:delete_public": "删除公开构作视图",
  "dramaturgy_view:overwrite_public": "覆盖公开构作视图",
  "dramaturgy_view:create": "创建构作视图",
  "dramaturgy_view:delete": "删除构作视图",
  "dramaturgy_view:overwrite": "覆盖构作视图",
  // 事件（per-event 写操作已迁移至 resource_grant）
  "event:delete_tech_req_any": "删除他人技术需求",
  "event:create": "创建事件",
  "event:create_tech_req": "创建技术需求",
  "event:edit_tech_req": "编辑技术需求",
  "event:assign_tech_req": "指派技术需求",
  "event:delete_tech_req": "删除技术需求",
  "event:create_tech_req_any": "创建他人技术需求",
  "event:edit_tech_req_any": "编辑他人技术需求",
  "event:assign_tech_req_any": "指派他人技术需求",
  "event:view_call_sheet_any": "查看他人Call Sheet",
  "event:view_tech_req": "查看技术需求",
  "event:view_tech_req_any": "查看他人技术需求",
  "event:follow": "关注事件",
  // 报告（per-report 写操作已迁移至 resource_grant）
  "report:create": "创建报告",
  "report:create_note_any": "创建他人记录",
  "report:edit_note_any": "编辑他人记录",
  "report:delete_note_any": "删除他人记录",
  "report:edit_comment_any": "编辑他人报告评论",
  "report:delete_comment_any": "删除他人报告评论",
  "report:reply": "回复报告",
  "note:edit_comment_any": "编辑他人备注评论",
  "note:delete_comment_any": "删除他人备注评论",
  "note:comment": "评论备注",
  // 附件
  "asset:view_any": "查看他人附件",
  "asset:delete_any": "删除他人附件",
  "asset:rename_any": "重命名他人附件",
  "asset:change_type_any": "修改他人附件类型",
  "asset:overwrite_any": "覆盖他人附件",
  "asset:mount_any": "挂载他人附件",
  "asset:unmount_any": "卸载他人附件",
  "asset:create": "上传附件",
  "asset:rename": "重命名附件",
  "asset:overwrite": "覆盖附件",
  "asset:change_type": "修改附件类型",
  "asset:delete": "删除附件",
  "asset:mount": "挂载附件",
  "asset:unmount": "卸载附件",
  "asset:view": "查看附件",
  "asset:download": "下载附件",
  "asset:download_any": "下载他人附件",
  "asset:share": "分享附件",
  "asset:share_downloadable": "分享附件（可下载）",
  "asset:share_any": "分享他人附件",
  "asset:share_any_downloadable": "分享他人附件（可下载）",
  // 组织
  "org:assign_member": "分配组织成员",
  "org:recall_member": "收回组织成员",
};

// Group by permission-key prefix (before the colon). Falls back to the raw
// prefix as the group label if a new domain hasn't been mapped here yet —
// keeps this page from silently dropping newly-added permissions.
const GROUP_LABELS: Record<string, string> = {
  production: "项目管理",
  contacts: "通讯录",
  members: "成员管理",
  role: "职位管理",
  dept: "部门管理",
  script: "剧本",
  rehearsal_mark: "剧本",
  scene: "场次",
  character: "角色",
  tag_group: "标注体系",
  tag_option: "标注体系",
  cue_list: "Cue表",
  cue: "Cue表",
  dramaturgy: "构作",
  dramaturgy_view: "构作",
  event: "事件",
  report: "报告",
  note: "报告",
  asset: "附件",
  org: "组织",
};

const GROUP_ORDER = [
  "项目管理", "通讯录", "成员管理", "职位管理", "部门管理",
  "剧本", "场次", "角色", "标注体系", "Cue表", "构作", "事件", "报告", "附件", "组织",
];

function buildPermissionGroups(): { label: string; perms: Permission[] }[] {
  const buckets = new Map<string, Permission[]>();
  for (const perm of ALL_PERMISSIONS) {
    const prefix = perm.split(":")[0];
    const label = GROUP_LABELS[prefix] ?? prefix;
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label)!.push(perm);
  }
  const ordered = GROUP_ORDER.filter((label) => buckets.has(label));
  const extra = [...buckets.keys()].filter((label) => !GROUP_ORDER.includes(label));
  return [...ordered, ...extra].map((label) => ({ label, perms: buckets.get(label)! }));
}

const PERMISSION_GROUPS = buildPermissionGroups();

type PermissionEntry = { granted: boolean; overridden: boolean };

type ProductionPerms = {
  id: string;
  name: string;
  archivedAt: string | null;
  roles: string[];
  permissions: Record<string, PermissionEntry>;
};

type ApiResponse = {
  isAdmin: boolean;
  productions: ProductionPerms[];
};

export default function PermissionsClient() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/my/permissions`)
      .then(r => r.json())
      .then((d: ApiResponse) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-10">
      <div className="w-full max-w-sm mx-auto">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <Link href="/" className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
            ← 返回
          </Link>
          <div className="text-right">
            <p className="text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase">Permissions</p>
            <p className="text-[10px] text-zinc-300">我的权限</p>
          </div>
        </div>

        {loading ? (
          <p className="py-10 text-center text-xs text-zinc-400">加载中…</p>
        ) : !data ? (
          <p className="py-10 text-center text-xs text-red-400">加载失败</p>
        ) : (
          <>
            {/* SA status card */}
            <div className={`mb-4 rounded-2xl shadow-sm px-5 py-4 flex items-center justify-between ${
              data.isAdmin ? "bg-amber-50" : "bg-white"
            }`}>
              <div>
                <p className="text-xs font-semibold tracking-widest text-zinc-400 uppercase mb-0.5">超级管理员</p>
                <p className="text-[11px] text-zinc-400">
                  {data.isAdmin
                    ? "可访问全部项目，绕过所有权限检查"
                    : "非超管，权限由项目角色决定"}
                </p>
              </div>
              <span className={`text-sm font-bold ${data.isAdmin ? "text-amber-500" : "text-zinc-300"}`}>
                {data.isAdmin ? "是" : "否"}
              </span>
            </div>

            {/* Per-production cards */}
            {data.productions.length === 0 ? (
              <div className="rounded-2xl bg-white shadow-sm px-5 py-8 text-center">
                <p className="text-xs text-zinc-400">你尚未加入任何项目</p>
              </div>
            ) : (
              <div className="space-y-3">
                {data.productions.map(prod => {
                  const isExp = expanded === prod.id;
                  return (
                    <div key={prod.id} className="rounded-2xl bg-white shadow-sm overflow-hidden">
                      {/* Production header row */}
                      <button
                        onClick={() => setExpanded(isExp ? null : prod.id)}
                        className="w-full flex items-center justify-between px-5 py-4 text-left"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-zinc-800 truncate">{prod.name}</p>
                            {prod.archivedAt && (
                              <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold tracking-widest uppercase bg-zinc-100 text-zinc-400 shrink-0">
                                已归档
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {(prod.roles ?? []).length === 0 ? (
                              <span className="text-[11px] text-zinc-300">无角色</span>
                            ) : prod.roles.map(r => (
                              <span key={r} className="rounded px-1.5 py-0.5 text-[10px] bg-zinc-100 text-zinc-500">
                                {r}
                              </span>
                            ))}
                          </div>
                        </div>
                        <span className="ml-3 text-[10px] text-zinc-300 shrink-0">{isExp ? "▲" : "▼"}</span>
                      </button>

                      {/* Expanded permission breakdown */}
                      {isExp && (
                        <div className="border-t border-zinc-50 px-5 py-4 space-y-4">
                          {PERMISSION_GROUPS.map(group => (
                            <div key={group.label}>
                              <p className="text-[10px] font-semibold tracking-widest text-zinc-300 uppercase mb-2">
                                {group.label}
                              </p>
                              <div className="space-y-1.5">
                                {group.perms.map(perm => {
                                  const entry = prod.permissions[perm];
                                  if (!entry) return null;
                                  return (
                                    <div key={perm} className="flex items-center justify-between gap-2">
                                      <span className="text-[11px] text-zinc-500">
                                        {PERMISSION_LABELS[perm] ?? perm}
                                      </span>
                                      <div className="flex items-center gap-1.5 shrink-0">
                                        {entry.overridden && (
                                          <span className="text-[9px] text-purple-400 font-medium">覆盖</span>
                                        )}
                                        <span className={`text-[11px] font-semibold ${
                                          entry.granted ? "text-emerald-500" : "text-zinc-300"
                                        }`}>
                                          {entry.granted ? "✓" : "✕"}
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Legend */}
            <div className="mt-4 px-1 flex items-center gap-4 text-[10px] text-zinc-300">
              <span><span className="text-emerald-500 font-semibold">✓</span> 有权限</span>
              <span><span className="text-zinc-300 font-semibold">✕</span> 无权限</span>
              <span><span className="text-purple-400 font-semibold">覆盖</span> 管理员手动设置</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
