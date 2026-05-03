"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { Version, VersionStatus } from "@/lib/db";

const STATUS_LABELS: Record<VersionStatus, string> = {
  editing: "编辑中",
  committed: "已提交",
  frozen: "已冻结",
  archived: "已归档",
};

const STATUS_COLORS: Record<VersionStatus, string> = {
  editing: "bg-emerald-100 text-emerald-700",
  committed: "bg-amber-100 text-amber-700",
  frozen: "bg-blue-100 text-blue-700",
  archived: "bg-zinc-100 text-zinc-500",
};

// Status transitions: what statuses can a version move to from its current status
const NEXT_STATUSES: Record<VersionStatus, VersionStatus[]> = {
  editing:   ["committed"],
  committed: ["frozen", "archived"],
  frozen:    ["archived"],
  archived:  [],
};
const STATUS_TRANSITION_LABELS: Record<VersionStatus, string> = {
  editing:   "",
  committed: "提交",
  frozen:    "冻结",
  archived:  "归档",
};

function buildTree(versions: Version[]): Map<string | null, Version[]> {
  const map = new Map<string | null, Version[]>();
  for (const v of versions) {
    const key = v.parentVersionId;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(v);
  }
  return map;
}

// ancestorLines[i] = true means depth-i ancestor has more siblings → draw │
function TreePrefix({ ancestorLines, isLast }: { ancestorLines: boolean[]; isLast: boolean }) {
  if (ancestorLines.length === 0) return null;
  return (
    <div className="flex shrink-0 self-stretch" aria-hidden>
      {ancestorLines.map((hasLine, i) => (
        <div key={i} className="relative w-4 shrink-0 self-stretch">
          {hasLine && <div className="absolute left-[7px] inset-y-0 w-px bg-zinc-200" />}
        </div>
      ))}
      {/* connector for this node */}
      <div className="relative w-4 shrink-0 self-stretch">
        <div className={`absolute left-[7px] w-px bg-zinc-200 ${isLast ? "top-0 h-[19px]" : "inset-y-0"}`} />
        <div className="absolute left-[7px] right-0 top-[18px] h-px bg-zinc-200" />
      </div>
    </div>
  );
}

function VersionRow({
  version,
  isLast,
  ancestorLines,
  childMap,
  productionId,
  onUpdate,
  onCreate,
}: {
  version: Version;
  isLast: boolean;
  ancestorLines: boolean[];
  childMap: Map<string | null, Version[]>;
  productionId: string;
  onUpdate: (v: Version) => void;
  onCreate: (v: Version) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(version.name);
  const [editDesc, setEditDesc] = useState(version.description);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  const children = childMap.get(version.id) ?? [];

  async function saveEdits() {
    setSaving(true);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/versions/${version.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName.trim(), description: editDesc }),
    });
    const data = await res.json();
    setSaving(false);
    if (data.version) { onUpdate(data.version); setEditing(false); }
  }

  async function changeStatus(status: VersionStatus) {
    setMenuOpen(false);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/versions/${version.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const data = await res.json();
    if (data.version) onUpdate(data.version);
  }

  async function rollback() {
    setMenuOpen(false);
    const name = `回滚至 ${version.name}`;
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/versions/${version.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rollback: true, rollbackName: name }),
    });
    const data = await res.json();
    if (data.version) onCreate(data.version);
  }

  async function createChild() {
    setCreating(true);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromVersionId: version.id }),
    });
    const data = await res.json();
    setCreating(false);
    if (data.version) onCreate(data.version);
  }

  const nextStatuses = NEXT_STATUSES[version.status];
  const canRollback = version.status !== "editing";

  return (
    <>
      <div className="flex items-start hover:bg-zinc-50 rounded-lg pr-2 group">
        <TreePrefix ancestorLines={ancestorLines} isLast={isLast} />
        <div className="flex items-start gap-2 py-2 flex-1 min-w-0 pl-1">
        {/* Expand/collapse toggle */}
        <button
          onClick={() => setExpanded(e => !e)}
          className={`mt-0.5 w-4 h-4 shrink-0 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-600 transition-colors ${children.length === 0 ? "opacity-0 pointer-events-none" : ""}`}
        >
          <svg className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`} viewBox="0 0 12 12" fill="none">
            <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex flex-col gap-2">
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm focus:outline-none focus:border-zinc-400"
                onKeyDown={e => { if (e.key === "Enter") saveEdits(); if (e.key === "Escape") setEditing(false); }}
                autoFocus
              />
              <input
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                placeholder="描述（可选）"
                className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm text-zinc-500 focus:outline-none focus:border-zinc-400"
              />
              <div className="flex gap-2">
                <button onClick={saveEdits} disabled={saving}
                  className="px-3 py-1 rounded-lg bg-zinc-800 text-white text-xs font-medium hover:bg-zinc-700 disabled:opacity-50">
                  {saving ? "保存中…" : "保存"}
                </button>
                <button onClick={() => setEditing(false)}
                  className="px-3 py-1 rounded-lg bg-zinc-100 text-zinc-600 text-xs hover:bg-zinc-200">
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm text-zinc-800">{version.name}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_COLORS[version.status]}`}>
                {STATUS_LABELS[version.status]}
              </span>
              {version.description && (
                <span className="text-xs text-zinc-400 truncate max-w-[200px]">{version.description}</span>
              )}
              <span className="text-xs text-zinc-300">
                {new Date(version.createdAt).toLocaleDateString("zh-CN")}
              </span>
            </div>
          )}
        </div>

        {!editing && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button
              onClick={createChild}
              disabled={creating}
              className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 transition-colors disabled:opacity-50"
            >
              {creating ? "创建中…" : "新建子版本"}
            </button>
            <button
              onClick={() => setEditing(true)}
              className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 transition-colors"
            >
              编辑
            </button>
            {(nextStatuses.length > 0 || canRollback) && (
              <div className="relative">
                <button
                  onClick={() => setMenuOpen(o => !o)}
                  className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 transition-colors"
                >
                  •••
                </button>
                {menuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-30 min-w-[140px] rounded-xl border border-zinc-200 bg-white shadow-lg py-1">
                    {nextStatuses.map(s => (
                      <button
                        key={s}
                        onClick={() => changeStatus(s)}
                        className="w-full px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50"
                      >
                        {STATUS_TRANSITION_LABELS[s]}
                      </button>
                    ))}
                    {canRollback && (
                      <>
                        {nextStatuses.length > 0 && <div className="mx-3 my-1 border-t border-zinc-100" />}
                        <button
                          onClick={rollback}
                          className="w-full px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50"
                        >
                          从此版本回滚
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        </div>{/* end inner flex */}
      </div>

      {expanded && children.map((child, i) => (
        <VersionRow
          key={child.id}
          version={child}
          isLast={i === children.length - 1}
          ancestorLines={[...ancestorLines, !isLast]}
          childMap={childMap}
          productionId={productionId}
          onUpdate={onUpdate}
          onCreate={onCreate}
        />
      ))}
    </>
  );
}

export default function VersionManagePage({
  productionId,
  productionName,
  initialVersions,
}: {
  productionId: string;
  productionName: string;
  initialVersions: Version[];
}) {
  const [versions, setVersions] = useState<Version[]>(initialVersions);
  const [creating, setCreating] = useState(false);

  const handleUpdate = useCallback((updated: Version) => {
    setVersions(prev => prev.map(v => v.id === updated.id ? updated : v));
  }, []);

  const handleCreate = useCallback((created: Version) => {
    setVersions(prev => [...prev, created]);
  }, []);

  async function createRootVersion() {
    setCreating(true);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    setCreating(false);
    if (data.version) handleCreate(data.version);
  }

  const childMap = buildTree(versions);
  const roots = childMap.get(null) ?? [];

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="sticky top-0 z-10 border-b border-zinc-100 bg-white shadow-sm">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-6">
          <Link
            href={`/production/${productionId}`}
            className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            ← 返回
          </Link>
          <div className="h-4 w-px bg-zinc-100" />
          <span className="text-sm text-zinc-400 truncate">{productionName}</span>
          <div className="h-4 w-px bg-zinc-100" />
          <span className="text-sm font-medium text-zinc-700">版本管理</span>
          <div className="flex-1" />
          <button
            onClick={createRootVersion}
            disabled={creating}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-white font-medium hover:bg-zinc-700 transition-colors disabled:opacity-50"
          >
            {creating ? "创建中…" : "新建版本"}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">
        {versions.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-zinc-400 text-sm">暂无版本</p>
            <button
              onClick={createRootVersion}
              disabled={creating}
              className="rounded-lg bg-zinc-800 px-4 py-2 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {creating ? "创建中…" : "创建第一个版本"}
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-200 bg-white p-2">
            {roots.map((root, i) => (
              <VersionRow
                key={root.id}
                version={root}
                isLast={i === roots.length - 1}
                ancestorLines={[]}
                childMap={childMap}
                productionId={productionId}
                onUpdate={handleUpdate}
                onCreate={handleCreate}
              />
            ))}
          </div>
        )}

        <div className="mt-6 rounded-xl border border-zinc-100 bg-white p-4">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-3">版本状态说明</h2>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {(["editing", "committed", "frozen", "archived"] as VersionStatus[]).map(s => (
              <div key={s} className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_COLORS[s]}`}>
                  {STATUS_LABELS[s]}
                </span>
                <span className="text-xs text-zinc-500">
                  {s === "editing"   && "剧本可编辑，Cue 可编辑"}
                  {s === "committed" && "剧本只读，Cue 可编辑"}
                  {s === "frozen"    && "剧本只读，Cue 只读"}
                  {s === "archived"  && "已归档，不可操作"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
