"use client";

// wiki 文档库 W4：文档页（阅读/编辑/tag/移动/分享/backlinks）。
// 编辑器 = SmartTextarea markdown 模式 + `[[` 文档补全 + @成员 + #剧本引用；
// 阅读 = WikiMarkdown（react-markdown 管线）。

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import { fmtDateTime } from "@/lib/tz";
import SmartTextarea, { wikiLinkDropPlugin, type MentionMember } from "@/components/SmartTextarea";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";
import TreePickerModal from "@/components/TreePickerModal";
import AdminModal from "@/components/AdminModal";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import type { WikiDoc, WikiListEntry, WikiRef } from "@/lib/wiki-db";
import type { Mention } from "@/lib/event-db";

type ShareLevel = "view" | "edit" | "manage";
type ShareState = {
  isPublic: boolean;
  deptIds: string[];
  people: { userId: string; level: ShareLevel }[];
};

const LEVEL_LABELS: Record<ShareLevel, string> = { view: "可阅读", edit: "可编辑", manage: "可管理" };

export default function WikiDocClient({
  productionId,
  wiki,
  wikis,
  canEdit,
  canDelete,
  canShare,
  members,
  departments,
  backlinks,
  unlinked,
}: {
  productionId: string;
  wiki: WikiDoc & { tags: string[] };
  wikis: WikiListEntry[];
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
  members: MentionMember[];
  departments: { id: string; name: string }[];
  backlinks: WikiRef[];
  unlinked: WikiRef[];
}) {
  const router = useRouter();
  const api = `${BASE_PATH}/api/production/${productionId}/wiki/${wiki.id}`;

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(wiki.title ?? "");
  const [body, setBody] = useState(wiki.body);
  const [tagsInput, setTagsInput] = useState(wiki.tags.join(" "));
  const [mentions, setMentions] = useState<Mention[]>(wiki.mentions);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const [share, setShare] = useState<ShareState | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareAddUser, setShareAddUser] = useState("");
  const [shareAddLevel, setShareAddLevel] = useState<ShareLevel>("view");

  const memberName = (userId: string) => members.find(m => m.userId === userId)?.name ?? userId.slice(0, 8);

  async function save() {
    if (busy) return;
    if (!title.trim()) { alert("标题不能为空"); return; }
    setBusy(true);
    try {
      const res = await fetch(api, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body,
          mentions,
          tags: tagsInput.split(/[\s,，]+/).filter(Boolean),
        }),
      });
      if (!res.ok) { alert((await res.json()).error ?? "保存失败"); return; }
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`确认删除「${wiki.title}」？子文档将提升为顶层。`)) return;
    const res = await fetch(api, { method: "DELETE" });
    if (!res.ok) { alert((await res.json()).error ?? "删除失败"); return; }
    router.push(`/production/${productionId}/wiki`);
    router.refresh();
  }

  async function move(targetIds: string[]) {
    const target = targetIds[0];
    setMoving(false);
    const parentId = target === "__root__" ? null : target;
    const res = await fetch(api, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "移动失败"); return; }
    router.refresh();
  }

  async function openShare() {
    setShareOpen(true);
    if (share) return;
    const res = await fetch(`${api}/share`);
    if (res.ok) setShare(await res.json() as ShareState);
  }

  async function putShare(patch: Record<string, unknown>) {
    const res = await fetch(`${api}/share`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) { alert((await res.json()).error ?? "分享设置失败"); return false; }
    const fresh = await fetch(`${api}/share`);
    if (fresh.ok) setShare(await fresh.json() as ShareState);
    router.refresh();
    return true;
  }

  // 移动目标：排除自己与后代（防环，服务端也会校验）
  const descendants = new Set<string>([wiki.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const w of wikis) {
      if (w.parentId && descendants.has(w.parentId) && !descendants.has(w.id)) {
        descendants.add(w.id); grew = true;
      }
    }
  }
  const moveItems = [
    { id: "__root__", label: "（移到顶层）" },
    ...wikis.filter(w => !descendants.has(w.id)).map(w => ({
      id: w.id, label: w.title ?? "（无标题）", parentId: w.parentId,
    })),
  ];

  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      {/* 标题区 */}
      <div className="px-6 pt-5 pb-4 border-b border-zinc-100">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            {editing ? (
              <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                className="w-full text-xl font-bold text-zinc-900 outline-none border-b border-dashed border-zinc-300 focus:border-zinc-500 pb-1"
                placeholder="文档标题"
              />
            ) : (
              <h1 className="text-xl font-bold text-zinc-900 truncate">{wiki.title}</h1>
            )}
            <p className="mt-1.5 text-xs text-zinc-400">
              更新于 {fmtDateTime(wiki.updatedAt)}
              {wiki.isPublic && <span className="ml-2 text-emerald-600">· 全体可见</span>}
            </p>
            {/* tags */}
            {editing ? (
              <input
                value={tagsInput}
                onChange={e => setTagsInput(e.target.value)}
                placeholder="标签（空格分隔，自由手写）"
                className="mt-2 w-full rounded-lg border border-zinc-200 px-2.5 py-1 text-xs outline-none focus:border-zinc-400"
              />
            ) : wiki.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {wiki.tags.map(t => (
                  <span key={t} className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600">#{t}</span>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            {editing ? (
              <>
                <button type="button" style={SECONDARY_BTN} onClick={() => {
                  setEditing(false); setTitle(wiki.title ?? ""); setBody(wiki.body); setTagsInput(wiki.tags.join(" "));
                }}>取消</button>
                <button type="button" style={PRIMARY_BTN} onClick={save} disabled={busy}>
                  {busy ? "保存中…" : "保存"}
                </button>
              </>
            ) : (
              <>
                {canShare && <button type="button" style={SECONDARY_BTN} onClick={openShare}>分享</button>}
                {canEdit && <button type="button" style={SECONDARY_BTN} onClick={() => setMoving(true)}>移动</button>}
                {canDelete && <button type="button" style={{ ...SECONDARY_BTN, color: "#b91c1c", borderColor: "#b91c1c" }} onClick={remove}>删除</button>}
                {canEdit && <button type="button" style={PRIMARY_BTN} onClick={() => setEditing(true)}>编辑</button>}
              </>
            )}
          </div>
        </div>
      </div>

      {/* 正文 */}
      <div className="px-6 py-5">
        {editing ? (
          <SmartTextarea
            value={body}
            onChange={setBody}
            markdown
            minHeight={320}
            placeholder="正文（markdown）。输入 [[ 引用文档、@ 提及成员、# 引用剧本内容"
            memberMention={{ members, onMentionsChange: m => setMentions(m.map(x => ({ userId: x.userId, name: x.name }))) }}
            contentMention={{ productionId }}
            plugins={[wikiLinkDropPlugin(productionId)]}
          />
        ) : wiki.body.trim() ? (
          <WikiMarkdown content={wiki.body} productionId={productionId} />
        ) : (
          <p className="text-sm text-zinc-400">（空文档{canEdit ? "，点击右上角编辑" : ""}）</p>
        )}
      </div>

      {/* 链接图面板：标题级列出（§4.1） */}
      {(backlinks.length > 0 || unlinked.length > 0) && (
        <div className="px-6 py-4 border-t border-zinc-100 space-y-3">
          {backlinks.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-zinc-400 mb-1.5">反向链接 {backlinks.length}</p>
              <div className="flex flex-wrap gap-1.5">
                {backlinks.map(b => (
                  <Link key={b.id} href={`/production/${productionId}/wiki/${b.id}`}
                    className="rounded-md bg-sky-50 border border-sky-200 px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-100">
                    [[{b.title ?? "（无标题）"}]]
                  </Link>
                ))}
              </div>
            </div>
          )}
          {unlinked.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-zinc-400 mb-1.5">未链接的提及 {unlinked.length}</p>
              <div className="flex flex-wrap gap-1.5">
                {unlinked.map(b => (
                  <Link key={b.id} href={`/production/${productionId}/wiki/${b.id}`}
                    className="rounded-md bg-zinc-50 border border-zinc-200 px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100">
                    {b.title ?? "（无标题）"}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 移动 */}
      {moving && (
        <TreePickerModal
          kicker="Wiki"
          title="移动到…"
          items={moveItems}
          preselected={[]}
          single
          onConfirm={move}
          onClose={() => setMoving(false)}
        />
      )}

      {/* 分享 */}
      {shareOpen && (
        <AdminModal title={`分享「${wiki.title}」`} onClose={() => setShareOpen(false)}>
          {!share ? (
            <p className="text-sm text-zinc-400 py-4">加载中…</p>
          ) : (
            <div className="space-y-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={share.isPublic}
                  onChange={e => putShare({ isPublic: e.target.checked })}
                />
                <span>公开给全体成员</span>
              </label>

              <div>
                <p className="font-medium mb-1.5">分享给部门</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {departments.map(d => (
                    <label key={d.id} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={share.deptIds.includes(d.id)}
                        onChange={e => {
                          const next = e.target.checked
                            ? [...share.deptIds, d.id]
                            : share.deptIds.filter(x => x !== d.id);
                          putShare({ deptIds: next });
                        }}
                      />
                      <span>{d.name}</span>
                    </label>
                  ))}
                  {departments.length === 0 && <span className="text-zinc-400">（无部门）</span>}
                </div>
              </div>

              <div>
                <p className="font-medium mb-1.5">分享给个人</p>
                <div className="flex gap-1.5 mb-2">
                  <select
                    value={shareAddUser}
                    onChange={e => setShareAddUser(e.target.value)}
                    className="flex-1 rounded-lg border border-zinc-200 px-2 py-1.5 outline-none"
                  >
                    <option value="">选择成员…</option>
                    {members
                      .filter(m => !share.people.some(p => p.userId === m.userId))
                      .map(m => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                  </select>
                  <select
                    value={shareAddLevel}
                    onChange={e => setShareAddLevel(e.target.value as ShareLevel)}
                    className="rounded-lg border border-zinc-200 px-2 py-1.5 outline-none"
                  >
                    {(Object.keys(LEVEL_LABELS) as ShareLevel[]).map(l =>
                      <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
                  </select>
                  <button
                    type="button"
                    style={{ ...PRIMARY_BTN, padding: "6px 10px" }}
                    disabled={!shareAddUser}
                    onClick={async () => {
                      if (await putShare({ addPerson: { userId: shareAddUser, level: shareAddLevel } })) {
                        setShareAddUser("");
                      }
                    }}
                  >
                    添加
                  </button>
                </div>
                <ul className="space-y-1">
                  {share.people.map(p => (
                    <li key={p.userId} className="flex items-center justify-between rounded-lg bg-zinc-50 px-2.5 py-1.5">
                      <span>{memberName(p.userId)} <span className="text-zinc-400 text-xs">· {LEVEL_LABELS[p.level]}</span></span>
                      <button
                        type="button"
                        className="text-xs text-red-600 hover:underline"
                        onClick={() => putShare({ removePersonUserId: p.userId })}
                      >
                        移除
                      </button>
                    </li>
                  ))}
                  {share.people.length === 0 && <li className="text-zinc-400 text-xs px-1">（尚未单独分享给任何人）</li>}
                </ul>
              </div>
            </div>
          )}
        </AdminModal>
      )}
    </div>
  );
}
