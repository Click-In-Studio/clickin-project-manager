"use client";

import { useState, useRef, useEffect } from "react";
import { BASE_PATH } from "@/lib/base-path";

export type SavedView = {
  id: string;
  name: string;
  isDefault: boolean;
  config: unknown;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  productionId: string;
  views: SavedView[];
  activeViewId: string | null;
  currentConfig: unknown;
  onSelectView: (view: SavedView) => void;
  onViewsChange: (views: SavedView[]) => void;
};

export default function TableViewSelector({
  productionId,
  views,
  activeViewId,
  currentConfig,
  onSelectView,
  onViewsChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const activeView = views.find((v) => v.id === activeViewId);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingName(null);
        setConfirmDelete(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSaveView = async () => {
    if (!activeViewId || saving) return;
    setSaving(true);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/scene-table-views/${activeViewId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config: currentConfig }),
        }
      );
      if (!res.ok) throw new Error("保存失败");
      onViewsChange(views.map((v) => v.id === activeViewId ? { ...v, config: currentConfig } : v));
      setOpen(false);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateView = async () => {
    if (!newName.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scene-table-views`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          config: currentConfig,
          isDefault: views.length === 0,
        }),
      });
      if (!res.ok) throw new Error("创建失败");
      const data = await res.json();
      onViewsChange([...views, data]);
      onSelectView(data);
      setNewName("");
      setEditingName(null);
      setOpen(false);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (viewId: string) => {
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/scene-table-views/${viewId}/default`,
        { method: "PATCH" }
      );
      if (!res.ok) throw new Error("设置失败");
      const updated = views.map((v) => ({ ...v, isDefault: v.id === viewId }));
      onViewsChange(updated);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDelete = async (viewId: string) => {
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/scene-table-views/${viewId}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error("删除失败");
      const filtered = views.filter((v) => v.id !== viewId);
      onViewsChange(filtered);
      if (activeViewId === viewId) {
        onSelectView({
          id: "",
          name: "",
          isDefault: false,
          config: currentConfig,
          createdAt: "",
          updatedAt: "",
        });
      }
      setConfirmDelete(null);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 rounded-lg transition-colors"
      >
        <span className="max-w-[120px] truncate">
          {activeView?.name || "默认视图"}
        </span>
        <span className="text-zinc-400">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 rounded-xl border border-zinc-200 bg-white shadow-lg z-20">
          <div className="py-1 max-h-64 overflow-y-auto">
            {views.length === 0 && (
              <div className="px-3 py-2 text-xs text-zinc-400">
                暂无保存的视图
              </div>
            )}
            {views.map((view) => (
              <div
                key={view.id}
                className={`flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-50 ${
                  view.id === activeViewId ? "bg-zinc-50" : ""
                }`}
              >
                <button
                  onClick={() => { onSelectView(view); setOpen(false); }}
                  className="flex-1 text-left text-xs text-zinc-600 truncate"
                >
                  <span className="flex items-center gap-1">
                    {view.name}
                    {view.isDefault && (
                      <span className="text-[10px] text-zinc-400">默认</span>
                    )}
                  </span>
                </button>
                {!view.isDefault && (
                  <button
                    onClick={() => handleSetDefault(view.id)}
                    className="text-[10px] text-zinc-400 hover:text-zinc-600"
                    title="设为默认"
                  >
                    ★
                  </button>
                )}
                {confirmDelete === view.id ? (
                  <button
                    onClick={() => handleDelete(view.id)}
                    className="text-[10px] text-red-500 hover:text-red-700"
                  >
                    确认
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(view.id)}
                    className="text-[10px] text-zinc-300 hover:text-red-400"
                    title="删除视图"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="border-t border-zinc-100 p-2 flex flex-col gap-0.5">
            {activeViewId && (
              <button
                onClick={handleSaveView}
                disabled={saving}
                className="w-full text-left px-2 py-1 text-xs text-zinc-700 font-medium hover:bg-zinc-50 rounded disabled:opacity-50"
              >
                {saving ? "保存中…" : "↑ 保存到当前视图"}
              </button>
            )}
            {editingName ? (
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateView();
                    if (e.key === "Escape") { setEditingName(null); setNewName(""); }
                  }}
                  placeholder="视图名称"
                  className="flex-1 rounded border border-zinc-200 px-2 py-1 text-xs outline-none focus:border-zinc-400"
                  disabled={saving}
                />
                <button
                  onClick={handleCreateView}
                  disabled={saving || !newName.trim()}
                  className="px-2 py-1 text-xs text-white bg-zinc-800 hover:bg-zinc-700 rounded disabled:opacity-50"
                >
                  {saving ? "…" : "保存"}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setEditingName("new")}
                className="w-full text-left px-2 py-1 text-xs text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50 rounded"
              >
                + 另存为新视图
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
