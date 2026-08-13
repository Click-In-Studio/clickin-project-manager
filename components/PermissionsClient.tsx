"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import { ALL_PERMISSIONS, type Permission } from "@/lib/permissions";

const PERMISSION_LABELS: Partial<Record<Permission, string>> = {
  // 项目管理
  // 通讯录
  // 成员管理
  // 职位管理
  // 部门管理
  // 剧本
  // 场次
  // 角色
  // 标注体系
  // Cue表
  // 构作
  // 事件（per-event 写操作已迁移至 resource_grant）
  // 报告（per-report 写操作已迁移至 resource_grant）
  // 附件
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
