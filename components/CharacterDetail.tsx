"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { CharacterDetail } from "@/lib/db";

const ROLE_TYPES = ["演员", "肢体", "画外音"] as const;

type Props = {
  productionId: string;
  productionName: string;
  character: CharacterDetail;
  allCharacters: CharacterDetail[];
  canEdit: boolean;
  versionId?: string | null;
};

function Field({
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
  const inputCls =
    "w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 disabled:opacity-50 disabled:cursor-default";
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">
        {label}
      </label>
      {readOnly ? (
        <p className="text-sm text-zinc-700 py-2 min-h-[2.25rem]">{value || <span className="text-zinc-300">—</span>}</p>
      ) : multiline ? (
        <textarea
          rows={4}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          className={inputCls + " resize-none"}
        />
      ) : (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          className={inputCls}
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
    <div className="space-y-1.5">
      <label className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">
        角色属性
      </label>
      <div className="flex gap-2 flex-wrap py-1">
        {ROLE_TYPES.map((rt) => (
          <button
            key={rt}
            onClick={() => !readOnly && onSave(value === rt ? "" : rt)}
            disabled={readOnly}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors disabled:cursor-default ${
              value === rt
                ? "bg-zinc-800 text-white"
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

function AggregateMembersField({
  character,
  allCharacters,
  canEdit,
  onUpdateMembers,
}: {
  character: CharacterDetail;
  allCharacters: CharacterDetail[];
  canEdit: boolean;
  onUpdateMembers: (ids: string[]) => void;
}) {
  const [saving, setSaving] = useState(false);
  const candidates = allCharacters.filter((c) => !c.isAggregate && c.id !== character.id);

  const toggle = async (memberId: string) => {
    if (!canEdit || saving) return;
    const next = character.memberIds.includes(memberId)
      ? character.memberIds.filter((id) => id !== memberId)
      : [...character.memberIds, memberId];
    setSaving(true);
    try { onUpdateMembers(next); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">
        聚合成员
      </label>
      {candidates.length === 0 ? (
        <p className="text-sm text-zinc-300 py-1">暂无可选角色</p>
      ) : (
        <div className="flex flex-wrap gap-2 py-1">
          {candidates.map((c) => {
            const active = character.memberIds.includes(c.id);
            return (
              <button
                key={c.id}
                onClick={() => toggle(c.id)}
                disabled={!canEdit || saving}
                className={`rounded-lg px-3 py-1.5 text-sm transition-colors disabled:cursor-default ${
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

export default function CharacterDetailView({
  productionId,
  productionName,
  character: initial,
  allCharacters: initialAll,
  canEdit,
  versionId,
}: Props) {
  const router = useRouter();
  const [character, setCharacter] = useState(initial);
  const [allCharacters, setAllCharacters] = useState(initialAll);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmConvert, setConfirmConvert] = useState(false);
  const [converting, setConverting] = useState(false);

  const patch = async (body: Record<string, unknown>) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/characters/${character.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  const saveName = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === character.name) return;
    await patch({ name: trimmed });
    setCharacter((c) => ({ ...c, name: trimmed }));
    setAllCharacters((prev) => prev.map((c) => c.id === character.id ? { ...c, name: trimmed } : c));
  };

  const saveMeta = async (fields: Partial<{ gender: string; biography: string; roleType: string }>) => {
    await patch(versionId ? { ...fields, versionId } : fields);
    setCharacter((c) => ({ ...c, ...fields }));
  };

  const updateMembers = async (memberIds: string[]) => {
    await patch({ memberIds });
    setCharacter((c) => ({ ...c, memberIds }));
  };

  const convertAggregate = async (toAggregate: boolean) => {
    setConverting(true);
    try {
      await patch({ isAggregate: toAggregate });
      setCharacter((c) => ({ ...c, isAggregate: toAggregate, memberIds: [] }));
      setConfirmConvert(false);
    } finally {
      setConverting(false);
    }
  };

  const del = async () => {
    setDeleting(true);
    try {
      await fetch(`${BASE_PATH}/api/production/${productionId}/characters/${character.id}`, {
        method: "DELETE",
      });
      router.push(`/production/${productionId}/characters`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-8">
      <div className="mx-auto max-w-lg">
        <div className="mb-6 flex items-center justify-between">
          <Link
            href={`/production/${productionId}/characters`}
            className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            ← 返回角色列表
          </Link>
          <div className="text-right">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">Character</p>
            <p className="text-sm font-bold text-zinc-500">{productionName}</p>
          </div>
        </div>

        <div className="rounded-2xl bg-white shadow-sm p-6 space-y-5">
          {/* 名称 + 聚合标签 */}
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <Field
                label="姓名"
                value={character.name}
                onSave={saveName}
                readOnly={!canEdit}
              />
            </div>
            {character.isAggregate && (
              <div className="mt-6 shrink-0 rounded bg-violet-100 px-2 py-1 text-xs font-medium text-violet-600">
                聚合角色
              </div>
            )}
          </div>

          <div className="border-t border-zinc-100" />

          {character.isAggregate ? (
            <AggregateMembersField
              character={character}
              allCharacters={allCharacters}
              canEdit={canEdit}
              onUpdateMembers={updateMembers}
            />
          ) : (
            <>
              <Field
                label="性别"
                value={character.gender}
                onSave={(v) => saveMeta({ gender: v })}
                readOnly={!canEdit}
              />
              <RoleTypeField
                value={character.roleType}
                onSave={(v) => saveMeta({ roleType: v })}
                readOnly={!canEdit}
              />
              <Field
                label="人物小传"
                value={character.biography}
                onSave={(v) => saveMeta({ biography: v })}
                multiline
                readOnly={!canEdit}
              />
            </>
          )}

          {(
            <div className="pt-2 border-t border-zinc-100 space-y-3">
              {/* 聚合类型切换 */}
              {confirmConvert ? (
                <div className="flex items-center gap-3">
                  <p className="text-sm text-zinc-500 flex-1">
                    {character.isAggregate
                      ? "转为普通角色后聚合成员关系将清空，确认？"
                      : "转为聚合角色后性别/小传等信息仍保留，确认？"}
                  </p>
                  <button
                    onClick={() => convertAggregate(!character.isAggregate)}
                    disabled={converting}
                    className="rounded-lg bg-violet-500 px-3 py-1.5 text-sm text-white hover:bg-violet-600 disabled:opacity-50"
                  >
                    {converting ? "处理中…" : "确认"}
                  </button>
                  <button
                    onClick={() => setConfirmConvert(false)}
                    className="text-sm text-zinc-400 hover:text-zinc-600"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmConvert(true)}
                  className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:border-violet-300 hover:text-violet-600 transition-colors"
                >
                  {character.isAggregate ? "转为普通角色" : "转为聚合角色"}
                </button>
              )}

              {/* 删除 */}
              {!confirmConvert && (
                confirmDelete ? (
                  <div className="flex items-center gap-3">
                    <p className="text-sm text-zinc-500 flex-1">确认删除角色「{character.name}」？</p>
                    <button
                      onClick={del}
                      disabled={deleting}
                      className="rounded-lg bg-red-500 px-3 py-1.5 text-sm text-white hover:bg-red-600 disabled:opacity-50"
                    >
                      {deleting ? "删除中…" : "确认"}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="text-sm text-zinc-400 hover:text-zinc-600"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="text-sm text-red-400 hover:text-red-600 transition-colors"
                  >
                    删除角色
                  </button>
                )
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
