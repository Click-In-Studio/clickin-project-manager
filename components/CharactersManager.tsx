"use client";

import { useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { CharacterDetail } from "@/lib/db";

const ROLE_TYPES = ["演员", "肢体", "画外音"] as const;

type Props = {
  productionId: string;
  productionName: string;
  initialCharacters: CharacterDetail[];
  canEdit: boolean;
  embedded?: boolean;
  versionId?: string | null;
  initialExpandedId?: string;
};

function MetaField({
  label,
  value,
  onSave,
  multiline,
  readOnly,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
  multiline?: boolean;
  readOnly?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => { if (draft !== value) onSave(draft); };
  const cls = "w-full rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-700 outline-none focus:border-zinc-400 resize-none disabled:opacity-50 disabled:cursor-default";
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">{label}</p>
      {multiline ? (
        <textarea
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          disabled={readOnly}
          className={cls}
        />
      ) : (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          disabled={readOnly}
          className={cls}
        />
      )}
    </div>
  );
}

function RoleTypeField({
  value,
  onSave,
  readOnly,
}: {
  value: string;
  onSave: (v: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">角色属性</p>
      <div className="flex gap-1 flex-wrap">
        {ROLE_TYPES.map((rt) => (
          <button
            key={rt}
            onClick={() => !readOnly && onSave(value === rt ? "" : rt)}
            disabled={readOnly}
            className={`rounded px-2 py-0.5 text-xs transition-colors disabled:cursor-default ${
              value === rt
                ? "bg-zinc-700 text-white"
                : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 disabled:hover:bg-zinc-100"
            }`}
          >
            {rt}
          </button>
        ))}
      </div>
    </div>
  );
}

function AggregateMembersPanel({
  char,
  allChars,
  canEdit,
  onUpdateMembers,
}: {
  char: CharacterDetail;
  allChars: CharacterDetail[];
  canEdit: boolean;
  onUpdateMembers: (memberIds: string[]) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const candidates = allChars.filter((c) => !c.isAggregate && c.id !== char.id);

  const toggle = async (memberId: string) => {
    if (!canEdit || saving) return;
    const current = char.memberIds;
    const next = current.includes(memberId)
      ? current.filter((id) => id !== memberId)
      : [...current, memberId];
    setSaving(true);
    try { await onUpdateMembers(next); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">聚合成员</p>
      {candidates.length === 0 ? (
        <p className="text-xs text-zinc-300">暂无可选角色</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {candidates.map((c) => {
            const active = char.memberIds.includes(c.id);
            return (
              <button
                key={c.id}
                onClick={() => toggle(c.id)}
                disabled={!canEdit || saving}
                className={`rounded px-2 py-0.5 text-xs transition-colors disabled:cursor-default ${
                  active
                    ? "bg-violet-600 text-white"
                    : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 disabled:hover:bg-zinc-100"
                }`}
              >
                {c.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CharacterEditRow({
  char,
  allChars,
  canEdit,
  onRename,
  onDelete,
  onPatchMeta,
  onUpdateMembers,
  onConvert,
  expanded,
  onToggleExpand,
}: {
  char: CharacterDetail;
  allChars: CharacterDetail[];
  canEdit: boolean;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onPatchMeta: (fields: Partial<{ gender: string; biography: string; roleType: string }>) => Promise<void>;
  onUpdateMembers: (memberIds: string[]) => Promise<void>;
  onConvert: (toAggregate: boolean) => Promise<void>;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(char.name);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmConvert, setConfirmConvert] = useState(false);
  const [converting, setConverting] = useState(false);

  const convert = async () => {
    setConverting(true);
    try { await onConvert(!char.isAggregate); setConfirmConvert(false); }
    finally { setConverting(false); }
  };

  const commit = async () => {
    const t = draft.trim();
    if (!t || t === char.name) { setDraft(char.name); setEditing(false); return; }
    setSaving(true);
    try { await onRename(t); } finally { setSaving(false); setEditing(false); }
  };

  const del = async () => {
    setDeleting(true);
    try { await onDelete(); } finally { setDeleting(false); }
  };

  return (
    <>
      <tr className="group border-b border-zinc-100">
        {/* 姓名 */}
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(char.name); setEditing(false); } }}
                disabled={saving}
                className="w-full border-b border-zinc-400 text-sm text-zinc-800 outline-none disabled:opacity-50"
              />
            ) : (
              <span
                onClick={() => canEdit && setEditing(true)}
                className={`text-sm text-zinc-700 ${canEdit ? "cursor-text hover:text-zinc-900" : ""}`}
              >
                {char.name}
              </span>
            )}
            {char.isAggregate && (
              <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-600">
                聚合
              </span>
            )}
          </div>
        </td>

        {/* 性别 */}
        <td className="px-4 py-3 text-sm text-zinc-500">
          {char.isAggregate ? (
            <span className="text-zinc-300">—</span>
          ) : (
            char.gender || <span className="text-zinc-300">—</span>
          )}
        </td>

        {/* 角色属性 */}
        <td className="px-4 py-3">
          {char.isAggregate ? (
            char.memberIds.length > 0 ? (
              <span className="text-xs text-zinc-400">{char.memberIds.length} 人</span>
            ) : (
              <span className="text-zinc-300 text-xs">未配置</span>
            )
          ) : char.roleType ? (
            <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">{char.roleType}</span>
          ) : (
            <span className="text-zinc-300 text-sm">—</span>
          )}
        </td>

        {/* Actions */}
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-3">
            {canEdit && (
              confirmDelete ? (
                <span className="flex items-center gap-2">
                  <button onClick={del} disabled={deleting} className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50">
                    {deleting ? "删除中…" : "确认"}
                  </button>
                  <button onClick={() => setConfirmDelete(false)} className="text-xs text-zinc-400 hover:text-zinc-600">取消</button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="text-xs text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all"
                >
                  删除
                </button>
              )
            )}
            <button
              onClick={onToggleExpand}
              className={`text-xs transition-all ${expanded ? "text-zinc-500" : "text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-zinc-600"}`}
              title={expanded ? "收起" : "展开"}
            >
              {expanded ? "⌃" : "⌄"}
            </button>
          </div>
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-zinc-100 bg-zinc-50">
          <td colSpan={4} className="px-6 py-4 space-y-4">
            {char.isAggregate ? (
              <AggregateMembersPanel
                char={char}
                allChars={allChars}
                canEdit={canEdit}
                onUpdateMembers={onUpdateMembers}
              />
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <MetaField
                  label="性别"
                  value={char.gender}
                  onSave={(v) => onPatchMeta({ gender: v })}
                  readOnly={!canEdit}
                />
                <RoleTypeField
                  value={char.roleType}
                  onSave={(v) => onPatchMeta({ roleType: v })}
                  readOnly={!canEdit}
                />
                <div className="col-span-2">
                  <MetaField
                    label="人物小传"
                    value={char.biography}
                    onSave={(v) => onPatchMeta({ biography: v })}
                    multiline
                    readOnly={!canEdit}
                  />
                </div>
              </div>
            )}

            {canEdit && (
              <div className="border-t border-zinc-200 pt-3">
                {confirmConvert ? (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-zinc-500 flex-1">
                      {char.isAggregate ? "转为普通角色，聚合成员关系将清空，确认？" : "转为聚合角色，确认？"}
                    </span>
                    <button onClick={convert} disabled={converting} className="text-xs text-violet-600 hover:text-violet-800 disabled:opacity-50">
                      {converting ? "处理中…" : "确认"}
                    </button>
                    <button onClick={() => setConfirmConvert(false)} className="text-xs text-zinc-400 hover:text-zinc-600">取消</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmConvert(true)}
                    className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
                  >
                    {char.isAggregate ? "转为普通角色" : "转为聚合角色"}
                  </button>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Add form ─────────────────────────────────────────────────────────────────

function AddCharacterForm({
  productionId,
  allChars,
  onAdd,
}: {
  productionId: string;
  allChars: CharacterDetail[];
  onAdd: (char: CharacterDetail) => void;
}) {
  const [draft, setDraft] = useState("");
  const [isAggregate, setIsAggregate] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = allChars.filter((c) => !c.isAggregate);

  const toggleMember = (id: string) =>
    setMemberIds((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );

  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/characters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, isAggregate, memberIds: isAggregate ? memberIds : [] }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "添加失败"); return; }
      onAdd(data.char);
      setDraft("");
      setIsAggregate(false);
      setMemberIds([]);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="border-t border-zinc-100 px-4 py-3 space-y-2">
      <div className="flex items-center gap-3">
        <input
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
          onKeyDown={(e) => e.key === "Enter" && !isAggregate && add()}
          placeholder="新角色名…"
          className="min-w-0 flex-1 text-sm text-zinc-800 outline-none placeholder:text-zinc-300"
        />
        <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer select-none shrink-0">
          <input
            type="checkbox"
            checked={isAggregate}
            onChange={(e) => { setIsAggregate(e.target.checked); setMemberIds([]); }}
            className="accent-violet-500"
          />
          聚合角色
        </label>
        <button
          onClick={add}
          disabled={!draft.trim() || adding}
          className="shrink-0 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-30"
        >
          {adding ? "添加中…" : "添加"}
        </button>
      </div>

      {isAggregate && candidates.length > 0 && (
        <div className="pt-1 space-y-1">
          <p className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">选择聚合成员</p>
          <div className="flex flex-wrap gap-1.5">
            {candidates.map((c) => (
              <button
                key={c.id}
                onClick={() => toggleMember(c.id)}
                className={`rounded px-2 py-0.5 text-xs transition-colors ${
                  memberIds.includes(c.id)
                    ? "bg-violet-600 text-white"
                    : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

// ─── Manager ──────────────────────────────────────────────────────────────────

export default function CharactersManager({ productionId, productionName, initialCharacters, canEdit, embedded, versionId, initialExpandedId }: Props) {
  const [characters, setCharacters] = useState<CharacterDetail[]>(initialCharacters);
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId ?? null);

  const rename = async (id: string, name: string) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/characters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setCharacters((prev) => prev.map((c) => c.id === id ? { ...c, name } : c));
  };

  const del = async (id: string) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/characters/${id}`, { method: "DELETE" });
    setCharacters((prev) => prev.filter((c) => c.id !== id));
    if (expandedId === id) setExpandedId(null);
  };

  const patchMeta = async (id: string, fields: Partial<{ gender: string; biography: string; roleType: string }>) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/characters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(versionId ? { ...fields, versionId } : fields),
    });
    setCharacters((prev) => prev.map((c) => c.id === id ? { ...c, ...fields } : c));
  };

  const updateMembers = async (id: string, memberIds: string[]) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/characters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds }),
    });
    setCharacters((prev) => prev.map((c) => c.id === id ? { ...c, memberIds } : c));
  };

  const convert = async (id: string, toAggregate: boolean) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/characters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAggregate: toAggregate }),
    });
    setCharacters((prev) => prev.map((c) => c.id === id ? { ...c, isAggregate: toAggregate, memberIds: [] } : c));
  };

  const card = (
        <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
          {characters.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-zinc-300">暂无角色</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs text-zinc-400">
                  <th className="px-4 py-3 font-medium">姓名</th>
                  <th className="px-4 py-3 font-medium">性别</th>
                  <th className="px-4 py-3 font-medium">角色属性</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {characters.map((c) => (
                  <CharacterEditRow
                    key={c.id}
                    char={c}
                    allChars={characters}
                    canEdit={canEdit}
                    onRename={(name) => rename(c.id, name)}
                    onDelete={() => del(c.id)}
                    onPatchMeta={(fields) => patchMeta(c.id, fields)}
                    onUpdateMembers={(ids) => updateMembers(c.id, ids)}
                    onConvert={(toAggregate) => convert(c.id, toAggregate)}
                    expanded={expandedId === c.id}
                    onToggleExpand={() => setExpandedId(expandedId === c.id ? null : c.id)}
                  />
                ))}
              </tbody>
            </table>
          )}

          {canEdit && (
            <AddCharacterForm
              productionId={productionId}
              allChars={characters}
              onAdd={(char) => setCharacters((prev) => [...prev, char])}
            />
          )}
        </div>
  );

  if (embedded) return card;

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <Link href={`/production/${productionId}/script`} className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
            ← 返回剧本
          </Link>
          <div className="text-right">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">Characters</p>
            <p className="text-sm font-bold text-zinc-500">{productionName}</p>
          </div>
        </div>
        {card}
      </div>
    </div>
  );
}
