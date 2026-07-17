"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import type { CueList, CueListPermissionRow } from "@/lib/cue-list-types";
import type { MemberWithRoles } from "@/lib/db";

type Props = {
  productionId: string;
  productionName: string;
  initialCueList: CueList;
  initialPermissions: CueListPermissionRow[];
  members: MemberWithRoles[];
  canEdit: boolean;
  canManage: boolean;
  myOpenId: string;
};

function MetaField({
  label,
  labelHint,
  value,
  canEdit,
  multiline,
  mono,
  transform,
  maxLength,
  className,
  onSave,
}: {
  label: string;
  labelHint?: React.ReactNode;
  value: string;
  canEdit: boolean;
  multiline?: boolean;
  mono?: boolean;
  transform?: (v: string) => string;
  maxLength?: number;
  className?: string;
  onSave: (v: string) => Promise<string | void>;
}) {
  const [draft, setDraft] = useState(value);
  const [lastSeen, setLastSeen] = useState(value);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState("");

  if (lastSeen !== value) { setLastSeen(value); setDraft(value); setFieldError(""); }

  const commit = async () => {
    const committed = draft.trim();
    if (committed === value.trim()) return;
    setSaving(true);
    setFieldError("");
    try {
      const err = await onSave(committed);
      if (err) setFieldError(err);
    } finally { setSaving(false); }
  };

  const cls = `w-full rounded border border-zinc-200 px-2 py-1.5 text-xs outline-none focus:border-zinc-400 disabled:opacity-50 placeholder:text-zinc-300${mono ? " font-mono" : ""}`;

  return (
    <div className={`space-y-1${className ? ` ${className}` : ""}`}>
      <label className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">
        {label}
        {labelHint && <span className="ml-1 font-normal normal-case">{labelHint}</span>}
      </label>
      {canEdit ? (
        multiline ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            disabled={saving}
            rows={3}
            className={`${cls} resize-none`}
            placeholder="—"
          />
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(transform ? transform(e.target.value) : e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            disabled={saving}
            maxLength={maxLength}
            className={cls}
            placeholder="—"
          />
        )
      ) : (
        <p className={`text-xs text-zinc-600 whitespace-pre-wrap min-h-[1.25rem]${mono ? " font-mono" : ""}`}>
          {value || <span className="text-zinc-300 italic">—</span>}
        </p>
      )}
      {fieldError && <p className="text-[10px] text-red-500">{fieldError}</p>}
    </div>
  );
}

type PermState = "allow" | "deny" | "default";

function memberPermState(
  openId: string,
  permissions: CueListPermissionRow[],
): PermState {
  const row = permissions.find((p) => p.openId === openId);
  if (!row) return "default";
  return row.canEdit ? "allow" : "deny";
}

function PermissionRow({
  member,
  state,
  cueList,
  productionId,
  onUpdated,
}: {
  member: MemberWithRoles;
  state: PermState;
  cueList: CueList;
  productionId: string;
  onUpdated: (permissions: CueListPermissionRow[]) => void;
}) {
  const [saving, setSaving] = useState(false);

  const setTo = async (next: PermState) => {
    if (next === state) return;
    setSaving(true);
    try {
      const canEdit: boolean | null = next === "allow" ? true : next === "deny" ? false : null;
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/cuelists/${cueList.id}/permissions`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ openId: member.openId, canEdit }),
        }
      );
      if (res.ok) {
        const perms = await res.json() as CueListPermissionRow[];
        onUpdated(perms);
      }
    } finally {
      setSaving(false);
    }
  };

  const isDefaultEditor = cueList.defaultEditRoles.some((r) => member.roles.includes(r));

  return (
    <div className="flex items-center gap-2 py-2 border-b border-zinc-100 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-zinc-700 truncate">{member.name}</p>
        {member.roles.length > 0 && (
          <p className="text-[10px] text-zinc-400 truncate">{member.roles.join("、")}</p>
        )}
      </div>
      <div className="flex gap-1 shrink-0">
        {(["allow", "default", "deny"] as PermState[]).map((s) => {
          const labels: Record<PermState, string> = { allow: "允许", default: "默认", deny: "禁止" };
          const isActive = state === s;
          return (
            <button
              key={s}
              onClick={() => setTo(s)}
              disabled={saving}
              title={s === "default" ? (isDefaultEditor ? "默认：可编辑" : "默认：只读") : undefined}
              className={`rounded px-1.5 py-0.5 text-[10px] transition-colors disabled:cursor-default ${
                isActive
                  ? s === "allow"
                    ? "bg-emerald-600 text-white"
                    : s === "deny"
                    ? "bg-red-500 text-white"
                    : "bg-zinc-600 text-white"
                  : "bg-zinc-100 text-zinc-400 hover:bg-zinc-200"
              }`}
            >
              {labels[s]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function CueListDetail({
  productionId,
  initialCueList,
  initialPermissions,
  members,
  canEdit,
  canManage,
}: Props) {
  const router = useRouter();
  const [cueList, setCueList] = useState(initialCueList);
  const [permissions, setPermissions] = useState(initialPermissions);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const patch = async (fields: { name?: string; notes?: string; abbr?: string | null }): Promise<string | void> => {
    const res = await fetch(
      `${BASE_PATH}/api/production/${productionId}/cuelists/${cueList.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      }
    );
    if (res.ok) {
      setCueList((prev) => ({ ...prev, ...fields }));
      return;
    }
    if (res.status === 409) return "简称已被同项目其他Cue表使用";
    const j = await res.json() as { error?: string };
    return j.error ?? "保存失败";
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/cuelists/${cueList.id}`,
        { method: "DELETE" }
      );
      if (res.ok) router.push(`/production/${productionId}/cuelists`);
    } finally {
      setDeleting(false);
    }
  };

  const editableMembers = members.filter((m) => m.openId !== cueList.createdBy);

  return (
    <div className="flex min-h-screen flex-col items-center bg-zinc-100 px-4 py-8">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center justify-between">
          <Link
            href={`/production/${productionId}/cuelists`}
            className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            ← Cue表
          </Link>
          <h1 className="text-sm font-bold tracking-[0.2em] text-zinc-400 uppercase truncate max-w-[180px]">
            {cueList.name}
          </h1>
        </div>

        {/* Meta */}
        <div className="rounded-2xl bg-white shadow-sm p-4 space-y-3">
          <div className="flex items-start gap-2">
            <MetaField
              label="名称"
              value={cueList.name}
              canEdit={canEdit}
              className="flex-1 min-w-0"
              onSave={(v) => patch({ name: v })}
            />
            <MetaField
              label="简称"
              labelHint={<span className="text-zinc-300 text-[9px]">可选</span>}
              value={cueList.abbr ?? ""}
              canEdit={canEdit}
              mono
              transform={(v) => v.toUpperCase()}
              maxLength={8}
              className="w-16 shrink-0"
              onSave={(v) => patch({ abbr: v || null })}
            />
          </div>
          <MetaField
            label="备注"
            value={cueList.notes}
            canEdit={canEdit}
            multiline
            onSave={(v) => patch({ notes: v })}
          />
          <div className="flex gap-4 pt-1">
            {cueList.template && (
              <div>
                <p className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase mb-0.5">类型</p>
                <p className="text-xs text-zinc-600">{cueList.template}</p>
              </div>
            )}
            <div>
              <p className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase mb-0.5">创建者</p>
              <p className="text-xs text-zinc-600">{cueList.createdByName}</p>
            </div>
          </div>
        </div>

        {/* Permissions */}
        {canManage && (
          <div className="rounded-2xl bg-white shadow-sm p-4">
            <p className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase mb-3">编辑权限</p>
            {editableMembers.length === 0 ? (
              <p className="text-xs text-zinc-400 italic">暂无其他成员</p>
            ) : (
              <div>
                {editableMembers.map((m) => (
                  <PermissionRow
                    key={m.openId}
                    member={m}
                    state={memberPermState(m.openId, permissions)}
                    cueList={cueList}
                    productionId={productionId}
                    onUpdated={setPermissions}
                  />
                ))}
              </div>
            )}
            <p className="text-[10px] text-zinc-300 mt-3">
              &ldquo;默认&rdquo;按照角色的默认编辑权限；&ldquo;允许&rdquo;强制赋予；&ldquo;禁止&rdquo;强制剥夺。
            </p>
          </div>
        )}

        {/* Delete */}
        {canManage && (
          <div className="rounded-2xl bg-white shadow-sm p-4">
            <p className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase mb-3">危险操作</p>
            {confirmDelete ? (
              <div className="space-y-2">
                <p className="text-xs text-zinc-600">确认删除「{cueList.name}」？此操作不可撤销。</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting}
                    className="flex-1 rounded border border-zinc-200 py-1.5 text-xs text-zinc-500 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex-1 rounded bg-red-500 py-1.5 text-xs text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    {deleting ? "删除中…" : "确认删除"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-xs text-red-400 hover:text-red-600 transition-colors"
              >
                删除此Cue表
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
