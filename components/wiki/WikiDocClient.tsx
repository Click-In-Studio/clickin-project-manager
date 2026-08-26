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
import AdminModal from "@/components/AdminModal";
import DropdownPicker from "@/components/DropdownPicker";
import { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import { encodeAssetSrc } from "@/lib/mention-types";
import { collectWikilinkTitles, promoteWikilinks } from "@/lib/wiki-input-normalize";
import { checkFidelity, lineDiff, type FidelityDiff, type DiffHunk } from "@/lib/wiki-fidelity";
import type { WikiDoc, WikiRef, WikiEntityRef } from "@/lib/wiki-db";
import WikiEntityRefs from "@/components/wiki/WikiEntityRefs";
import type { WikiPeer } from "@/lib/wiki-collab";
import { mergeLines } from "@/lib/line-merge";
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
  entityRefs,
}: {
  productionId: string;
  wiki: WikiDoc & { tags: string[] };
  canEdit: boolean;
  canShare: boolean;
  members: MentionMember[];
  departments: { id: string; name: string }[];
  backlinks: WikiRef[];
  unlinked: WikiRef[];
  entityRefs: WikiEntityRef[];
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
  // 保真检测：富文本挂载时比对「解析 → 再序列化」与原文。失真则本篇自动落
  // 源码模式（不写入全局偏好）+ 提示；用户仍可手动切回（lossyOverride）。
  //
  // **比的是内容签名，不是字面**（lib/wiki-fidelity）。原先按字面比，列表符号
  // `*`→`-`、加粗 `__`→`**`、表格补空格这类纯书写风格的归一化全都会触发，
  // 实测有九种之多——误报比漏报更伤：用户被无缘无故踢回源码模式，久了就不再
  // 相信这个提示，真出事时也当没看见。
  const [lossy, setLossy] = useState<FidelityDiff | null>(null);
  const [lossyDiff, setLossyDiff] = useState<DiffHunk[]>([]);
  const lossyOverrideRef = useRef(false);
  function handleRoundTrip(serialized: string) {
    if (lossyOverrideRef.current) return;
    const result = checkFidelity(body, serialized);
    if (!result.lossy) return;
    setLossy(result);
    // 触发时必须能看见**差在哪**：只说一句"检测到失真"，我们自己都查不出来
    setLossyDiff(lineDiff(body, serialized));
    setEditorMode("source");
  }
  function switchMode(m: "wysiwyg" | "source") {
    if (m === "wysiwyg" && lossy) lossyOverrideRef.current = true;
    setEditorMode(m);
    localStorage.setItem("clickin-wiki-editor-mode", m);
  }
  const [share, setShare] = useState<ShareState | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [shareAddUser, setShareAddUser] = useState("");
  const [shareAddLevel, setShareAddLevel] = useState<ShareLevel>("view");

  const mentionsRef = useRef<Mention[]>(wiki.mentions);
  const savedRef = useRef({ title: wiki.title ?? "", body: wiki.body, tags: wiki.tags.join(" ") });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  // effect 闭包会捕获旧渲染的值，卸载兜底保存必须经 ref 取最新
  const latestRef = useRef({ title, body, tags: tagsInput });
  latestRef.current = { title, body, tags: tagsInput };

  // ── 多人协作（SSE）：presence 头像/远端光标/内容广播合并 ────────────────────
  const collabClientIdRef = useRef("");
  const [peers, setPeers] = useState<WikiPeer[]>([]);
  const presenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // clientId 惰性生成（渲染期调 Math.random 违反 purity lint）
    if (!collabClientIdRef.current) collabClientIdRef.current = Math.random().toString(36).slice(2);
    const cid = collabClientIdRef.current;
    const es = new EventSource(
      `${BASE_PATH}/api/production/${productionId}/wiki/${wiki.id}/stream?cid=${cid}`);
    es.addEventListener("presence", e => {
      try {
        const list = JSON.parse((e as MessageEvent).data) as WikiPeer[];
        setPeers(list.filter(p => p.clientId !== cid));
      } catch { /* 忽略坏帧 */ }
    });
    es.addEventListener("update", e => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as
          { byClientId: string | null; title: string | null; body: string; updatedAt: string; tags?: string[] };
        if (data.byClientId === cid) return; // 本端 PATCH 响应已处理
        const base = savedRef.current.body;
        const local = latestRef.current.body;
        // 本地干净 → 直接采纳；本地有未存改动 → 行级三路合并（本地为 mine）
        const nextBody = local === base ? data.body : mergeLines(base, local, data.body);
        savedRef.current.body = data.body;
        if (nextBody !== local) setBody(nextBody);
        // 标题：本地干净才跟随
        if (latestRef.current.title === savedRef.current.title) {
          savedRef.current.title = data.title ?? "";
          setTitle(data.title ?? "");
        }
        // 标签：同上，本地干净才跟随（省略字段=本帧没动标签）
        if (data.tags !== undefined && latestRef.current.tags === savedRef.current.tags) {
          savedRef.current.tags = data.tags.join(" ");
          setTagsInput(savedRef.current.tags);
        }
      } catch { /* 忽略坏帧 */ }
    });
    // 库级结构变化（同一条流，见 lib/wiki-collab.ts 的 library topic）。
    // 本篇被删 → 立刻退到文档库首页：软刷新会撞进服务端的 notFound()，
    // 把人从工程环境里弹到 404 页，比"文档没了"本身更难受。
    // 其余结构变化（别人新建/改名/移动/换标签）软刷新一下，左树跟着变。
    es.addEventListener("library", e => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { kind: string; wikiId: string };
        if (data.kind === "deleted" && data.wikiId === wiki.id) {
          router.replace(`/production/${productionId}/wiki`);
          return;
        }
        if (refreshTimerRef.current) return; // 批量结构变更（如 AI 连写几篇）合并成一次
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          router.refresh();
        }, 300);
      } catch { /* 忽略坏帧 */ }
    });
    return () => {
      es.close();
      setPeers([]);
      if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null; }
    };
  }, [wiki.id, productionId, router]);

  // 光标位置上报（trailing 节流 400ms——leading 会发陈旧位置）
  const pendingCursorRef = useRef<{ blockIndex: number; offset: number } | null>(null);
  function reportCursor(cursor: { blockIndex: number; offset: number }) {
    pendingCursorRef.current = cursor;
    if (presenceTimerRef.current) return;
    presenceTimerRef.current = setTimeout(() => {
      presenceTimerRef.current = null;
      const latest = pendingCursorRef.current;
      if (!latest) return;
      void fetch(`${BASE_PATH}/api/production/${productionId}/wiki/${wiki.id}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: collabClientIdRef.current, ...latest }),
      }).catch(() => {});
    }, 400);
  }

  const memberName = (userId: string) => members.find(m => m.userId === userId)?.name ?? userId.slice(0, 8);

  // 图片粘贴上传：presign → PUT R2 → 登记 asset → 挂载到本文档（mount_type=wiki，
  // 文档可见 ⇒ 图可见的让渡边）。返回存储形态 src——正文只存 asset id 不存 URL
  async function uploadWikiImage(file: File): Promise<{ src: string; alt: string } | null> {
    const base = `${BASE_PATH}/api/production/${productionId}/assets`;
    const fileName = file.name || "粘贴图片.png";
    try {
      const presignRes = await fetch(`${base}/presign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName, mimeType: file.type }),
      });
      if (!presignRes.ok) return null;
      const presign = await presignRes.json() as { uploadUrl: string; r2Key: string; fileId: string; contentType: string };
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": presign.contentType },
        body: file,
      });
      if (!putRes.ok) return null;
      const regRes = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageType: "r2", r2Key: presign.r2Key, fileId: presign.fileId,
          mimeType: file.type, fileSize: file.size,
          assetType: "reference", fileName,
        }),
      });
      if (!regRes.ok) return null;
      const { asset } = await regRes.json() as { asset: { id: string } };
      // 挂载失败不拦插入：上传者自己的行集仍可见，其余观看者等下次挂载补
      await fetch(`${base}/${asset.id}/mounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mountType: "wiki", mountId: wiki.id }),
      }).catch(() => {});
      return { src: encodeAssetSrc(asset.id), alt: fileName };
    } catch {
      return null;
    }
  }

  // 换文档时重置本地态（同组件复用于不同 wikiId 的导航）
  useEffect(() => {
    setTitle(wiki.title ?? "");
    setBody(wiki.body);
    setTagsInput(wiki.tags.join(" "));
    mentionsRef.current = wiki.mentions;
    savedRef.current = { title: wiki.title ?? "", body: wiki.body, tags: wiki.tags.join(" ") };
    setStatus("idle");
    setLossy(null);
    setLossyDiff([]);
    lossyOverrideRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiki.id]);

  // 源码模式手写的 [[标题]] → 存储态引用（语法大纲 §6.4）。只在保存路径上跑：
  // 富文本模式的 [[ 走 picker 直接插存储态，根本到不了这里；AI 的写入走 API，
  // 也不经过本组件——作用域正好等于「没有指令 UI 的人类输入」。
  // 解析不中就留幻影，绝不猜（同名歧义宁可让人自己点一下）。
  const titleMapRef = useRef<Map<string, string> | null>(null);
  async function promoteBody(b: string): Promise<string> {
    const titles = collectWikilinkTitles(b);
    if (titles.length === 0) return b;
    if (!titleMapRef.current) {
      try {
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki`);
        if (!res.ok) return b; // 取不到清单就不动正文，下次保存再试
        const data = await res.json() as { wikis?: { id: string; title: string | null }[] };
        const map = new Map<string, string>();
        for (const w of data.wikis ?? []) {
          if (w.title && w.id !== wiki.id && !map.has(w.title)) map.set(w.title, w.id);
        }
        titleMapRef.current = map;
      } catch { return b; }
    }
    return promoteWikilinks(b, titleMapRef.current);
  }

  async function saveNow(next?: { title?: string; body?: string; tags?: string }) {
    if (savingRef.current) return;
    // 占锁必须在任何 await 之前：promoteBody 可能要取一次文档清单，那段 await
    // 窗口里第二次 saveNow 会整个越过上面的守卫，两笔并发 PATCH。
    savingRef.current = true;
    try {
    // 必须经 latestRef 读最新值：schedule 的 setTimeout 捕获的是 arm 时那轮渲染的
    // 闭包，直接读 state 会保存"本次操作之前"的内容——单次操作（[[ 补全选中、
    // 拖放成链）会被整个丢掉（用户实测：刷新后只剩 [[x / 拖入内容消失）
    const cur = latestRef.current;
    const t = (next?.title ?? cur.title).trim();
    const b0 = next?.body ?? cur.body;
    const tg = next?.tags ?? cur.tags;
    if (!t) return; // 空标题不落库，等用户补
    const b = await promoteBody(b0);
    if (b !== b0) setBody(b); // 升格结果回灌，编辑器立刻显示 chip
    const prev = savedRef.current;
    if (t === prev.title && b === prev.body && tg === prev.tags) { setStatus(s => s === "dirty" ? "saved" : s); return; }
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
          // 协作：带上本端 base，服务端被他人推进时做行级三路合并
          baseBody: prev.body,
          clientId: collabClientIdRef.current,
        }),
      });
      if (!res.ok) { setStatus("error"); return; }
      const data = await res.json() as { wiki?: { body?: string } };
      const serverBody = data.wiki?.body ?? b;
      const structuralChange = t !== prev.title || tg !== prev.tags;
      savedRef.current = { title: t, body: serverBody, tags: tg };
      // 服务端合并产物 ≠ 本端提交 → 回灌（本端期间的新击键经下一轮 schedule 再保）
      if (serverBody !== b && latestRef.current.body === b) setBody(serverBody);
      setStatus("saved");
      // 标题/标签变化会影响侧栏树与搜索，刷新服务端数据；正文变化不刷（不打断输入）
      if (structuralChange) router.refresh();
      } catch {
        setStatus("error");
      }
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
            {/* 协作在场者（飞书式头像堆叠；tooltip 含光标行） */}
            {peers.length > 0 && (
              <div className="flex items-center -space-x-1.5 mr-1">
                {peers.slice(0, 5).map(p => (
                  <span
                    key={p.clientId}
                    title={`${p.userName}${p.blockIndex != null ? ` · 第 ${p.blockIndex + 1} 段` : " · 正在查看"}`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[11px] font-bold text-white overflow-hidden"
                    style={{ background: p.color }}
                  >
                    {p.avatarUrl
                      ? // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.avatarUrl} alt={p.userName} className="h-full w-full object-cover" />
                      : (p.userName || "?").slice(0, 1)}
                  </span>
                ))}
                {peers.length > 5 && (
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-zinc-300 text-[10px] font-bold text-white">
                    +{peers.length - 5}
                  </span>
                )}
              </div>
            )}
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
                  {/* 打印页现在是独立路由（#335）。新标签打开：wiki 是默认即编辑，
                      同标签跳走会把编辑态一起带走。 */}
                  <Link
                    href={`/production/${productionId}/wiki/${wiki.id}/print`}
                    target="_blank"
                    rel="noopener"
                    className="block w-full text-left px-3 py-1.5 text-[13px] text-zinc-700 hover:bg-zinc-50"
                    onClick={() => setExportOpen(false)}
                  >
                    PDF（打印页）
                  </Link>
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
          <div className="mb-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 print:hidden">
            <p>
              检测到富文本模式<strong>会丢内容</strong>的语法，已用源码模式打开——
              切回富文本并编辑，下面列出的东西会被改写或丢失。
            </p>
            {/* 只说"检测到失真"是查不出问题的：必须把丢了什么、差在哪一并摆出来 */}
            {(lossy.missing.length > 0 || lossy.added.length > 0) && (
              <p className="mt-1.5 font-mono text-[11px] leading-relaxed">
                {lossy.missing.length > 0 && <>丢失：{lossy.missing.slice(0, 6).join(" / ")}{lossy.missing.length > 6 && ` …共 ${lossy.missing.length} 处`}</>}
                {lossy.added.length > 0 && <><br />多出：{lossy.added.slice(0, 6).join(" / ")}{lossy.added.length > 6 && ` …共 ${lossy.added.length} 处`}</>}
              </p>
            )}
            {lossyDiff.length > 0 && (
              <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-white/70 p-2 font-mono text-[11px] leading-relaxed">
                {lossyDiff.map((h, i) => (
                  <span key={i} className={h.kind === "removed" ? "text-red-700" : "text-emerald-700"}>
                    {h.kind === "removed" ? "- " : "+ "}{h.text}{"\n"}
                  </span>
                ))}
              </pre>
            )}
          </div>
        )}
        {canEdit ? (
          editorMode === "source" ? (
            <textarea
              value={body}
              onChange={e => { setBody(e.target.value); schedule(); }}
              placeholder="markdown 源码…（可直接写 [[文档标题]]，保存时自动解析成正式链接；写不中就留作幻影）"
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
              blockTools
              minHeight={360}
              placeholder="开始写作…（/ 插入块、[[ 引用文档、@ 提及成员、# 引用剧本内容）"
              memberMention={{
                members,
                onMentionsChange: m => { mentionsRef.current = m.map(x => ({ userId: x.userId, name: x.name })); },
              }}
              contentMention={{ productionId }}
              plugins={[wikiLinkDropPlugin(productionId)]}
              imageUpload={uploadWikiImage}
              onInitialRoundTrip={handleRoundTrip}
              remoteCursors={peers
                .filter(p => p.blockIndex != null)
                .map(p => ({ name: p.userName, color: p.color, blockIndex: p.blockIndex as number, offset: p.offset ?? 0 }))}
              onCursorChange={reportCursor}
            />
          )
        ) : wiki.body.trim() ? (
          <WikiMarkdown content={wiki.body} productionId={productionId} />
        ) : (
          <p className="text-sm text-zinc-400">（空文档）</p>
        )}
      </div>

      {/* 链接图面板：标题级列出（§4.1） */}
      {(backlinks.length > 0 || unlinked.length > 0 || entityRefs.length > 0) && (
        <div className="px-8 py-4 border-t border-zinc-100 space-y-3">
          <WikiEntityRefs productionId={productionId} wikiId={wiki.id} refs={entityRefs} canEdit={canEdit} />
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
