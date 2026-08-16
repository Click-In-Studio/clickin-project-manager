"use client";

// wiki 文档库 W4（Notion 式改版）：有编辑权即默认可编辑（无 编辑/保存 切换），
// 标题/正文/标签 就地编辑 + 防抖自动保存；文档操作（新建/移动/删除）归左侧栏
// （WikiShell），本区只留 分享。无编辑权 → 只读渲染（WikiMarkdown）。

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import { fmtDateTime } from "@/lib/tz";
import SmartTextarea, { wikiLinkDropPlugin, type MentionMember } from "@/components/SmartTextarea";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";
import WikiPrintOverlay from "@/components/wiki/WikiPrintOverlay";
import AdminModal from "@/components/AdminModal";
import DropdownPicker from "@/components/DropdownPicker";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import type { WikiDoc, WikiRef } from "@/lib/wiki-db";
import type { Mention } from "@/lib/event-db";

type ShareLevel = "view" | "edit" | "manage";
type ShareState = {
  isPublic: boolean;
  deptIds: string[];
  people: { userId: string; level: ShareLevel }[];
};

const LEVEL_LABELS: Record<ShareLevel, string> = { view: "可阅读", edit: "可编辑", manage: "可管理" };

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export default function WikiDocClient({
  productionId,
  wiki,
  canEdit,
  canShare,
  members,
  departments,
  backlinks,
  unlinked,
}: {
  productionId: string;
  wiki: WikiDoc & { tags: string[] };
  canEdit: boolean;
  canShare: boolean;
  members: MentionMember[];
  departments: { id: string; name: string }[];
  backlinks: WikiRef[];
  unlinked: WikiRef[];
}) {
  const router = useRouter();
  const api = `${BASE_PATH}/api/production/${productionId}/wiki/${wiki.id}`;

  const [title, setTitle] = useState(wiki.title ?? "");
  const [body, setBody] = useState(wiki.body);
  const [tagsInput, setTagsInput] = useState(wiki.tags.join(" "));
  const [status, setStatus] = useState<SaveStatus>("idle");
  // 编辑面双模：所见即所得（TipTap）/ markdown 源码（纯 textarea）；偏好持久化
  const [editorMode, setEditorMode] = useState<"wysiwyg" | "source">("wysiwyg");
  useEffect(() => {
    const saved = localStorage.getItem("clickin-wiki-editor-mode");
    if (saved === "source" || saved === "wysiwyg") setEditorMode(saved);
  }, []);
  // 保真检测：富文本挂载时对比"解析→再序列化"与原文——不支持的方言语法会被
  // prosemirror-markdown 转义/规范化，一旦编辑保存正文即被污染。失真则本篇
  // 自动落源码模式（不写入全局偏好）+ 提示；用户仍可手动切回（lossyOverride）。
  const [lossy, setLossy] = useState(false);
  const lossyOverrideRef = useRef(false);
  const normalizeForCompare = (s: string) =>
    s.replace(/\\\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
  function handleRoundTrip(serialized: string) {
    if (lossyOverrideRef.current) return;
    if (normalizeForCompare(serialized) !== normalizeForCompare(body)) {
      setLossy(true);
      setEditorMode("source");
    }
  }
  function switchMode(m: "wysiwyg" | "source") {
    if (m === "wysiwyg" && lossy) lossyOverrideRef.current = true;
    setEditorMode(m);
    localStorage.setItem("clickin-wiki-editor-mode", m);
  }
  const [share, setShare] = useState<ShareState | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [shareAddUser, setShareAddUser] = useState("");
  const [shareAddLevel, setShareAddLevel] = useState<ShareLevel>("view");

  const mentionsRef = useRef<Mention[]>(wiki.mentions);
  const savedRef = useRef({ title: wiki.title ?? "", body: wiki.body, tags: wiki.tags.join(" ") });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  // effect 闭包会捕获旧渲染的值，卸载兜底保存必须经 ref 取最新
  const latestRef = useRef({ title, body, tags: tagsInput });
  latestRef.current = { title, body, tags: tagsInput };

  const memberName = (userId: string) => members.find(m => m.userId === userId)?.name ?? userId.slice(0, 8);

  // 换文档时重置本地态（同组件复用于不同 wikiId 的导航）
  useEffect(() => {
    setTitle(wiki.title ?? "");
    setBody(wiki.body);
    setTagsInput(wiki.tags.join(" "));
    mentionsRef.current = wiki.mentions;
    savedRef.current = { title: wiki.title ?? "", body: wiki.body, tags: wiki.tags.join(" ") };
    setStatus("idle");
    setLossy(false);
    lossyOverrideRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiki.id]);

  async function saveNow(next?: { title?: string; body?: string; tags?: string }) {
    if (savingRef.current) return;
    const t = (next?.title ?? title).trim();
    const b = next?.body ?? body;
    const tg = next?.tags ?? tagsInput;
    if (!t) return; // 空标题不落库，等用户补
    const prev = savedRef.current;
    if (t === prev.title && b === prev.body && tg === prev.tags) { setStatus(s => s === "dirty" ? "saved" : s); return; }
    savingRef.current = true;
    setStatus("saving");
    try {
      const res = await fetch(api, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: t,
          body: b,
          mentions: mentionsRef.current,
          tags: tg.split(/[\s,，]+/).filter(Boolean),
        }),
      });
      if (!res.ok) { setStatus("error"); return; }
      const structuralChange = t !== prev.title || tg !== prev.tags;
      savedRef.current = { title: t, body: b, tags: tg };
      setStatus("saved");
      // 标题/标签变化会影响侧栏树与搜索，刷新服务端数据；正文变化不刷（不打断输入）
      if (structuralChange) router.refresh();
    } catch {
      setStatus("error");
    } finally {
      savingRef.current = false;
    }
  }

  function schedule() {
    setStatus("dirty");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => saveNow(), 1200);
  }

  // 卸载/切文档前尽力落一笔（经 latestRef 取最新值，避免闭包捕获旧渲染）
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const cur = latestRef.current;
      const prev = savedRef.current;
      if (cur.title.trim() && (cur.title.trim() !== prev.title || cur.body !== prev.body || cur.tags !== prev.tags)) {
        void saveNow({ title: cur.title, body: cur.body, tags: cur.tags });
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiki.id]);

  // 导出 markdown：原样下载正文源码（含私有 href token，暴力导出与导入对称）
  function exportMarkdown() {
    setExportOpen(false);
    const name = (title.trim() || wiki.title || "文档").replace(/[\\/:*?"<>|]/g, "_");
    const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.md`;
    a.click();
    URL.revokeObjectURL(url);
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

  const statusLabel =
    status === "saving" ? "保存中…"
    : status === "dirty" ? "编辑中…"
    : status === "error" ? "保存失败（继续输入将重试）"
    : status === "saved" ? "已保存"
    : `更新于 ${fmtDateTime(wiki.updatedAt)}`;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white flex flex-col">
      {/* 标题区 */}
      <div className="px-8 pt-6 pb-3">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            {canEdit ? (
              <input
                value={title}
                onChange={e => { setTitle(e.target.value); schedule(); }}
                className="w-full text-2xl font-bold text-zinc-900 outline-none placeholder:text-zinc-300"
                placeholder="无标题"
              />
            ) : (
              <h1 className="text-2xl font-bold text-zinc-900 truncate">{wiki.title}</h1>
            )}
            <p className="mt-1.5 text-xs text-zinc-400">
              {statusLabel}
              {status === "error" && null}
              {wiki.isPublic && <span className="ml-2 text-emerald-600">· 全体可见</span>}
              {!canEdit && <span className="ml-2">· 只读</span>}
            </p>
            {canEdit ? (
              <input
                value={tagsInput}
                onChange={e => { setTagsInput(e.target.value); schedule(); }}
                placeholder="＃ 标签（空格分隔，自由手写）"
                className="mt-2 w-full text-xs text-zinc-500 outline-none placeholder:text-zinc-300"
              />
            ) : wiki.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {wiki.tags.map(t => (
                  <span key={t} className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600">#{t}</span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="relative">
              <button type="button" style={SECONDARY_BTN} onClick={() => setExportOpen(v => !v)}>导出</button>
              {exportOpen && <div className="fixed inset-0 z-20" onClick={() => setExportOpen(false)} />}
              {exportOpen && (
                <div className="absolute right-0 top-full z-30 mt-1 w-40 rounded-lg border border-zinc-200 bg-white shadow-lg py-1">
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-[13px] text-zinc-700 hover:bg-zinc-50"
                    onClick={exportMarkdown}
                  >
                    Markdown（.md）
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-[13px] text-zinc-700 hover:bg-zinc-50"
                    onClick={() => { setExportOpen(false); setPrinting(true); }}
                  >
                    PDF（打印页）
                  </button>
                </div>
              )}
            </div>
            {canEdit && (
              <div className="flex rounded-lg border border-zinc-200 overflow-hidden text-[11px] font-medium">
                <button
                  type="button"
                  onClick={() => switchMode("wysiwyg")}
                  className={`px-2 py-1.5 ${editorMode === "wysiwyg" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:bg-zinc-50"}`}
                  title="所见即所得编辑"
                >
                  富文本
                </button>
                <button
                  type="button"
                  onClick={() => switchMode("source")}
                  className={`px-2 py-1.5 ${editorMode === "source" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:bg-zinc-50"}`}
                  title="markdown 源码编辑"
                >
                  源码
                </button>
              </div>
            )}
            {canShare && (
              <button type="button" style={SECONDARY_BTN} onClick={openShare}>分享</button>
            )}
          </div>
        </div>
      </div>

      {/* 正文：有编辑权即整页可写（Notion 式），防抖自动保存；富文本/源码双模 */}
      <div className={`flex-1 flex flex-col ${canEdit ? "px-5 pb-6" : "px-8 pb-6"}`}>
        {lossy && canEdit && (
          <p className="mb-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 print:hidden">
            检测到富文本模式无法无损保留的语法（其他 markdown 方言等），已用源码模式打开——
            切回富文本并编辑会转义/规范化这些内容。
          </p>
        )}
        {canEdit ? (
          editorMode === "source" ? (
            <textarea
              value={body}
              onChange={e => { setBody(e.target.value); schedule(); }}
              placeholder="markdown 源码…（[[链接]] 请写 [#标题](/__cm__wiki:<id>) 或切回富文本插入）"
              spellCheck={false}
              className="w-full flex-1 min-h-[360px] resize-none px-3 py-2 font-mono text-[13px] leading-relaxed text-zinc-800 outline-none bg-zinc-50/60 rounded-lg"
            />
          ) : (
            <SmartTextarea
              key={wiki.id}
              value={body}
              onChange={v => { setBody(v); schedule(); }}
              markdown
              frameless
              minHeight={360}
              placeholder="开始写作…（[[ 引用文档、@ 提及成员、# 引用剧本内容）"
              memberMention={{
                members,
                onMentionsChange: m => { mentionsRef.current = m.map(x => ({ userId: x.userId, name: x.name })); },
              }}
              contentMention={{ productionId }}
              plugins={[wikiLinkDropPlugin(productionId)]}
              onInitialRoundTrip={handleRoundTrip}
            />
          )
        ) : wiki.body.trim() ? (
          <WikiMarkdown content={wiki.body} productionId={productionId} />
        ) : (
          <p className="text-sm text-zinc-400">（空文档）</p>
        )}
      </div>

      {/* 链接图面板：标题级列出（§4.1） */}
      {(backlinks.length > 0 || unlinked.length > 0) && (
        <div className="px-8 py-4 border-t border-zinc-100 space-y-3">
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

      {/* 打印页（导出 PDF） */}
      {printing && (
        <WikiPrintOverlay
          productionId={productionId}
          title={title.trim() || wiki.title || "文档"}
          body={body}
          updatedAt={wiki.updatedAt}
          onClose={() => setPrinting(false)}
        />
      )}

      {/* 分享 */}
      {shareOpen && (
        <AdminModal title={`分享「${title || wiki.title || "文档"}」`} onClose={() => setShareOpen(false)}>
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
                {departments.length === 0 ? (
                  <span className="text-zinc-400">（无部门）</span>
                ) : (
                  <>
                    <DropdownPicker
                      multi
                      items={departments.map(d => ({ id: d.id, label: d.name }))}
                      values={new Set(share.deptIds)}
                      placeholder="选择部门…"
                      searchPlaceholder="搜索部门"
                      multiCountLabel={n => n === 0 ? "选择部门…" : `已分享 ${n} 个部门`}
                      onChange={() => {}}
                      onToggle={deptId => {
                        const next = share.deptIds.includes(deptId)
                          ? share.deptIds.filter(x => x !== deptId)
                          : [...share.deptIds, deptId];
                        putShare({ deptIds: next });
                      }}
                    />
                    {share.deptIds.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {share.deptIds.map(id => (
                          <span key={id} className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600">
                            {departments.find(d => d.id === id)?.name ?? id}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div>
                <p className="font-medium mb-1.5">分享给个人</p>
                <div className="flex gap-1.5 mb-2 items-start">
                  <div className="flex-1 min-w-0">
                    <DropdownPicker
                      items={members
                        .filter(m => !share.people.some(p => p.userId === m.userId))
                        .map(m => ({ id: m.userId, label: m.name }))}
                      value={shareAddUser || null}
                      placeholder="选择成员…"
                      searchPlaceholder="搜索成员"
                      onChange={id => setShareAddUser(id ?? "")}
                    />
                  </div>
                  <select
                    value={shareAddLevel}
                    onChange={e => setShareAddLevel(e.target.value as ShareLevel)}
                    className="rounded-lg border border-zinc-200 px-2 py-[9px] text-xs outline-none"
                  >
                    {(Object.keys(LEVEL_LABELS) as ShareLevel[]).map(l =>
                      <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
                  </select>
                  <button
                    type="button"
                    style={{ ...PRIMARY_BTN, padding: "8px 10px" }}
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
