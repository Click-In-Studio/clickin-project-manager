"use client";

import { useState, useRef } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { TagGroup, TagOption } from "@/lib/db";

type Props = {
  productionId: string;
  initialGroups: TagGroup[];
  canEdit: boolean;
  onGroupsChange?: (groups: TagGroup[]) => void;
  onClose?: () => void;
};

// ─── Color palette ────────────────────────────────────────────────────────────

const PALETTE = [
  "#ef4444", "#f97316", "#d97706", "#16a34a",
  "#14b8a6", "#0891b2", "#3b82f6", "#6366f1",
  "#8b5cf6", "#d946ef", "#ec4899", "#e11d48",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function apiFetch(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "请求失败" }));
    throw new Error(err.error ?? "请求失败");
  }
  return res.json();
}

// ─── AddGroupForm ─────────────────────────────────────────────────────────────

function AddGroupForm({
  productionId,
  onAdd,
}: {
  productionId: string;
  onAdd: (group: TagGroup) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<"exclusive" | "range">("exclusive");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError("名称不能为空"); return; }
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(
        `${BASE_PATH}/api/production/${productionId}/tag-groups`,
        "POST",
        { name: trimmed, type }
      );
      onAdd(data.group as TagGroup);
      setName("");
      setType("exclusive");
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-4 rounded border border-dashed border-zinc-300 px-4 py-2 text-sm text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 transition-colors w-full"
      >
        + 添加分组
      </button>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
      <p className="text-sm font-medium text-zinc-700">新建分组</p>
      <div className="space-y-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setOpen(false); }}
          placeholder="分组名称"
          className="w-full rounded border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm text-zinc-800 outline-none focus:border-zinc-400"
        />
        <div className="flex gap-2">
          {(["exclusive", "range"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`rounded px-3 py-1 text-xs transition-colors ${
                type === t
                  ? "bg-zinc-700 text-white"
                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
              }`}
            >
              {t === "exclusive" ? "单选" : "数值"}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={saving}
          className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-white hover:bg-zinc-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "创建中…" : "创建"}
        </button>
        <button
          onClick={() => { setOpen(false); setError(""); setName(""); }}
          className="rounded border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-50 transition-colors"
        >
          取消
        </button>
      </div>
    </div>
  );
}

// ─── AddOptionForm ────────────────────────────────────────────────────────────

function AddOptionForm({
  productionId,
  groupId,
  nextSortOrder,
  onAdd,
}: {
  productionId: string;
  groupId: string;
  nextSortOrder: number;
  onAdd: (option: TagOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState(() => PALETTE[nextSortOrder % PALETTE.length]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const trimmed = label.trim();
    if (!trimmed) { setError("名称不能为空"); return; }
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(
        `${BASE_PATH}/api/production/${productionId}/tag-groups/${groupId}/options`,
        "POST",
        { label: trimmed, color, sortOrder: nextSortOrder }
      );
      onAdd(data.option as TagOption);
      setLabel("");
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); setColor(PALETTE[nextSortOrder % PALETTE.length]); }}
        className="mt-1 text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
      >
        + 添加选项
      </button>
    );
  }

  return (
    <div className="mt-2 rounded border border-zinc-200 bg-zinc-50 p-3 space-y-2">
      <div className="flex gap-2 items-center">
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setOpen(false); }}
          placeholder="选项名称"
          className="flex-1 rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-800 outline-none focus:border-zinc-400"
        />
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="w-8 h-7 rounded border border-zinc-200 cursor-pointer p-0.5 bg-white"
        />
      </div>
      {error && <p className="text-[10px] text-red-500">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={saving}
          className="rounded bg-zinc-700 px-2 py-1 text-[10px] text-white hover:bg-zinc-600 disabled:opacity-50 transition-colors"
        >
          {saving ? "添加中…" : "添加"}
        </button>
        <button
          onClick={() => { setOpen(false); setError(""); }}
          className="text-[10px] text-zinc-400 hover:text-zinc-600 transition-colors"
        >
          取消
        </button>
      </div>
    </div>
  );
}

// ─── RangeGroupSettings ───────────────────────────────────────────────────────

function RangeGroupSettings({
  productionId,
  group,
  onUpdate,
}: {
  productionId: string;
  group: TagGroup;
  onUpdate: (updated: TagGroup) => void;
}) {
  const [min, setMin] = useState(group.rangeMin?.toString() ?? "");
  const [max, setMax] = useState(group.rangeMax?.toString() ?? "");
  const [step, setStep] = useState(group.rangeStep?.toString() ?? "1");
  const [def, setDef] = useState(group.rangeDefault?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const body: Record<string, number | null> = {
        rangeMin:     min  !== "" ? Number(min)  : null,
        rangeMax:     max  !== "" ? Number(max)  : null,
        rangeStep:    step !== "" ? Number(step) : null,
        rangeDefault: def  !== "" ? Number(def)  : null,
      };
      const data = await apiFetch(
        `${BASE_PATH}/api/production/${productionId}/tag-groups/${group.id}`,
        "PUT",
        body
      );
      onUpdate(data.group as TagGroup);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const numInput = (label: string, value: string, onChange: (v: string) => void) => (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-500 w-12 shrink-0">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 outline-none focus:border-zinc-400"
      />
    </div>
  );

  return (
    <div className="mt-2 space-y-2">
      {numInput("最小值", min, setMin)}
      {numInput("最大值", max, setMax)}
      {numInput("步长", step, setStep)}
      {numInput("默认值", def, setDef)}
      {error && <p className="text-[10px] text-red-500">{error}</p>}
      <button
        onClick={save}
        disabled={saving}
        className="rounded bg-zinc-700 px-3 py-1 text-xs text-white hover:bg-zinc-600 disabled:opacity-50 transition-colors"
      >
        {saving ? "保存中…" : "保存"}
      </button>
    </div>
  );
}

// ─── GroupCard ────────────────────────────────────────────────────────────────

function GroupCard({
  productionId,
  group,
  canEdit,
  onUpdate,
  onDelete,
}: {
  productionId: string;
  group: TagGroup;
  canEdit: boolean;
  onUpdate: (updated: TagGroup) => void;
  onDelete: (id: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pendingColors, setPendingColors] = useState<Record<string, string>>({});
  const [editingColorId, setEditingColorId] = useState<string | null>(null);
  const colorSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const handleColorInput = (optionId: string, newColor: string) => {
    setPendingColors((prev) => ({ ...prev, [optionId]: newColor }));
    if (colorSaveTimers.current[optionId]) clearTimeout(colorSaveTimers.current[optionId]);
    colorSaveTimers.current[optionId] = setTimeout(async () => {
      const option = group.options.find((o) => o.id === optionId);
      if (!option || newColor === option.color) {
        setPendingColors((prev) => { const next = { ...prev }; delete next[optionId]; return next; });
        return;
      }
      try {
        const data = await apiFetch(
          `${BASE_PATH}/api/production/${productionId}/tag-groups/${group.id}/options/${optionId}`,
          "PUT",
          { color: newColor }
        );
        onUpdate({ ...group, options: group.options.map((o) => o.id === optionId ? (data.option as TagOption) : o) });
      } finally {
        setPendingColors((prev) => { const next = { ...prev }; delete next[optionId]; return next; });
      }
    }, 800);
  };

  const handleDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    try {
      await apiFetch(
        `${BASE_PATH}/api/production/${productionId}/tag-groups/${group.id}`,
        "DELETE"
      );
      onDelete(group.id);
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleDeleteOption = async (optionId: string) => {
    await apiFetch(
      `${BASE_PATH}/api/production/${productionId}/tag-groups/${group.id}/options/${optionId}`,
      "DELETE"
    );
    onUpdate({ ...group, options: group.options.filter((o) => o.id !== optionId) });
  };

  const handleSetDefault = async (optionId: string) => {
    const newDefault = group.defaultOptionId === optionId ? null : optionId;
    const data = await apiFetch(
      `${BASE_PATH}/api/production/${productionId}/tag-groups/${group.id}`,
      "PUT",
      { defaultOptionId: newDefault }
    );
    onUpdate(data.group as TagGroup);
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-zinc-800 text-sm truncate">{group.name}</span>
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500 shrink-0">
            {group.type === "exclusive" ? "单选" : "数值"}
          </span>
        </div>
        {canEdit && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            onBlur={() => setConfirmDelete(false)}
            className={`shrink-0 rounded px-2 py-0.5 text-xs transition-colors ${
              confirmDelete
                ? "bg-red-500 text-white hover:bg-red-600"
                : "text-zinc-400 hover:text-red-500 hover:bg-red-50"
            } disabled:opacity-50`}
          >
            {deleting ? "删除中…" : confirmDelete ? "确认删除?" : "删除"}
          </button>
        )}
      </div>

      {group.type === "exclusive" ? (
        <div className="space-y-1">
          {group.options.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {group.options.map((opt) => {
                const displayColor = pendingColors[opt.id] ?? opt.color;
                return (
                  <div key={opt.id} className="flex items-center gap-1 group/opt">
                    <span
                      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium text-white"
                      style={{ backgroundColor: displayColor }}
                    >
                      {opt.label}
                    </span>
                    {canEdit && (
                      <div className={`${editingColorId === opt.id ? "flex" : "hidden group-hover/opt:flex"} items-center gap-0.5`}>
                        <label
                          title="更改颜色"
                          className="relative cursor-pointer w-3.5 h-3.5 rounded-full border border-zinc-300 inline-block shrink-0"
                          style={{ backgroundColor: displayColor }}
                          onMouseDown={() => setEditingColorId(opt.id)}
                        >
                          <input
                            type="color"
                            value={displayColor}
                            onChange={(e) => handleColorInput(opt.id, e.target.value)}
                            onBlur={() => setEditingColorId(null)}
                            className="absolute inset-0 opacity-0 w-full h-full cursor-pointer rounded-full"
                          />
                        </label>
                        <button
                          onClick={() => handleSetDefault(opt.id)}
                          title={group.defaultOptionId === opt.id ? "取消默认" : "设为默认"}
                          className={`rounded px-1 py-0.5 text-[10px] transition-colors ${
                            group.defaultOptionId === opt.id
                              ? "bg-zinc-700 text-white"
                              : "text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100"
                          }`}
                        >
                          {group.defaultOptionId === opt.id ? "默认" : "设默认"}
                        </button>
                        <button
                          onClick={() => handleDeleteOption(opt.id)}
                          className="text-zinc-300 hover:text-red-400 transition-colors px-0.5"
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-zinc-400">暂无选项</p>
          )}
          {canEdit && (
            <AddOptionForm
              productionId={productionId}
              groupId={group.id}
              nextSortOrder={group.options.length}
              onAdd={(opt) => onUpdate({ ...group, options: [...group.options, opt] })}
            />
          )}
        </div>
      ) : (
        canEdit ? (
          <RangeGroupSettings
            productionId={productionId}
            group={group}
            onUpdate={onUpdate}
          />
        ) : (
          <div className="text-xs text-zinc-500 space-y-1">
            {group.rangeMin != null && <span className="mr-3">最小: {group.rangeMin}</span>}
            {group.rangeMax != null && <span className="mr-3">最大: {group.rangeMax}</span>}
            {group.rangeStep != null && <span className="mr-3">步长: {group.rangeStep}</span>}
            {group.rangeDefault != null && <span>默认: {group.rangeDefault}</span>}
          </div>
        )
      )}
    </div>
  );
}

// ─── TagGroupEditor ───────────────────────────────────────────────────────────

export default function TagGroupEditor({ productionId, initialGroups, canEdit, onGroupsChange, onClose }: Props) {
  const [groups, setGroups] = useState<TagGroup[]>(
    [...initialGroups].sort((a, b) => a.sortOrder - b.sortOrder)
  );

  const handleAdd = (group: TagGroup) => {
    const next = [...groups, group];
    setGroups(next);
    onGroupsChange?.(next);
  };

  const handleUpdate = (updated: TagGroup) => {
    const next = groups.map((g) => g.id === updated.id ? updated : g);
    setGroups(next);
    onGroupsChange?.(next);
  };

  const handleDelete = (id: string) => {
    const next = groups.filter((g) => g.id !== id);
    setGroups(next);
    onGroupsChange?.(next);
  };

  return (
    <div className="space-y-3">
      {groups.length === 0 && (
        <p className="text-sm text-zinc-400 text-center py-8">
          暂无标签分组
        </p>
      )}
      {groups.map((group) => (
        <GroupCard
          key={group.id}
          productionId={productionId}
          group={group}
          canEdit={canEdit}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
        />
      ))}
      {canEdit && (
        <AddGroupForm productionId={productionId} onAdd={handleAdd} />
      )}
    </div>
  );
}
