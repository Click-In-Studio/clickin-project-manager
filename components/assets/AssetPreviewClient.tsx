"use client";

import { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { buildArchiveTree, flattenTree, allDirPaths } from "@/lib/asset/archive-view";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import AssetShareModal from "./AssetShareModal";

const WaveformPlayer = lazy(() => import("./WaveformPlayer"));
const VideoPlayer = lazy(() => import("./VideoPlayer"));

type PreviewType = "image" | "video" | "audio" | "pdf";

interface Props {
  productionId: string;
  assetId: string;
  versionId: string | null;
  fileName: string;
  mimeType: string | null;
  storageType: string;
  feishuUrl: string | null;
  userName: string;
  /** embedded：内嵌在知识库 shell 主区（#420 第二批）——卡片外壳、去掉整页
   *  导航（返回/Asset 列表），其余（下载/分享/预览体）同一份。 */
  variant?: "page" | "embedded";
}

function getPreviewType(mimeType: string | null): PreviewType | null {
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  return null;
}

// #85 元数据信封（展示所需的最小面；完整定义 lib/asset/metadata.ts）
interface MetaEnvelope {
  status: string;
  detectedType: string | null;
  data: Record<string, unknown> | null;
  sidecarKey: string | null;
}

// 打包类公约 entry 形状（lib/asset/metadata-parsers.ts）
interface ArchiveEntry {
  path: string;
  uncompressedBytes: number | null;
  isDirectory: boolean;
  mtime?: string;
  encrypted?: boolean;
}

/** 清单前端渲染上限（5000 行 DOM 太重；数据层另有 ARCHIVE_ENTRY_CAP）。 */
const ARCHIVE_RENDER_CAP = 1000;

// zip 包内工程分析结果（#85 PR3；v4 起 meta 携带工程元数据本体）
interface ArchiveProject {
  path: string;
  refCount?: number;
  missingCount?: number;
  error?: string;
  meta?: Record<string, unknown>;
}

// ADM 母版展示面（#85：多声道对象音频不能喂给 WaveformPlayer 假装能放）
interface AdmView {
  programmes: { name: string; start?: string; end?: string }[];
  objectCount: number;
  trackUidCount?: number;
  objects: { name: string; start?: string; duration?: string }[];
  objectsTruncated: boolean;
  channels?: number;
  sampleRate?: number;
  bitDepth?: number;
  durationSeconds?: number | null;
}

function pickAdmView(m: MetaEnvelope | null | undefined): AdmView | null {
  const admD = m?.data?.adm as Record<string, unknown> | undefined;
  if (!admD || typeof admD !== "object") return null;
  const d = m!.data!;
  return {
    programmes: Array.isArray(admD.programmes) ? (admD.programmes as AdmView["programmes"]) : [],
    objectCount: typeof admD.objectCount === "number" ? admD.objectCount : 0,
    trackUidCount: typeof admD.trackUidCount === "number" ? admD.trackUidCount : undefined,
    objects: Array.isArray(d.admObjects) ? (d.admObjects as AdmView["objects"]) : [],
    objectsTruncated: admD.objectsTruncated === true,
    channels: typeof d.channels === "number" ? d.channels : undefined,
    sampleRate: typeof d.sampleRate === "number" ? d.sampleRate : undefined,
    bitDepth: typeof d.bitDepth === "number" ? d.bitDepth : undefined,
    durationSeconds: typeof d.durationSeconds === "number" ? d.durationSeconds : null,
  };
}

/** 工程行的结构摘要「199 cue」「6 轨」。 */
function projectMetaSummary(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const parts: string[] = [];
  if (typeof meta.cueCount === "number") parts.push(`${meta.cueCount} cue`);
  if (typeof meta.trackCount === "number") parts.push(`${meta.trackCount} 轨`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** 探测类型 → 展示标签。认不出的直接显示 detectedType 原文。 */
const TYPE_LABELS: Record<string, string> = {
  "image/png": "PNG 图片", "image/jpeg": "JPEG 图片", "image/gif": "GIF 图片",
  "image/webp": "WebP 图片", "image/tiff": "TIFF 图片",
  "audio/wav": "WAV 音频", "audio/mpeg": "MP3 音频", "audio/flac": "FLAC 音频",
  "audio/ogg": "OGG 音频", "audio/aiff": "AIFF 音频", "audio/mp4": "M4A 音频", "audio/midi": "MIDI",
  "video/mp4": "MP4 视频", "video/quicktime": "QuickTime 视频", "video/webm": "WebM 视频",
  "video/x-matroska": "MKV 视频", "video/x-msvideo": "AVI 视频",
  "application/pdf": "PDF 文档", "application/zip": "ZIP 压缩包",
  "application/vnd.rar": "RAR 压缩包", "application/x-7z-compressed": "7z 压缩包",
  "application/gzip": "GZIP 压缩包",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word 文档",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel 表格",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPT 演示",
  "application/vnd.ableton.live-set": "Ableton 工程",
  "application/x-qlab4-workspace": "QLab 4 工作区",
  "application/x-qlab5-workspace": "QLab 5 工作区",
  "application/x-apple-bplist": "属性列表",
};

function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatDuration(s: number): string {
  const total = Math.round(s);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/** 信封 → 顶栏信息行「WAV 音频 · 48 kHz/24 bit · 3:45 · 24.1 MB」；无可展示项返回 null。 */
function metaInfoLine(meta: MetaEnvelope | null, fileSize: number | null): string | null {
  const parts: string[] = [];
  const d = meta?.data;
  // 身份优先：ADM 母版不是「一个 wav」，第一眼就要说清（2026-09-06 校准）
  if (d?.adm) parts.push("ADM 母版");
  else if (meta?.detectedType) parts.push(TYPE_LABELS[meta.detectedType] ?? meta.detectedType);
  if (typeof d?.width === "number" && typeof d?.height === "number") parts.push(`${d.width}×${d.height}`);
  if (typeof d?.sampleRate === "number" && typeof d?.bitDepth === "number" && d.bitDepth > 0)
    parts.push(`${d.sampleRate / 1000} kHz/${d.bitDepth} bit`);
  if (typeof d?.durationSeconds === "number")
    parts.push(`${d.estimated === true ? "≈" : ""}${formatDuration(d.durationSeconds)}`);
  if (typeof d?.entryCount === "number") parts.push(`${d.entryCount} 项`);
  const adm = d?.adm as { objectCount?: number } | undefined;
  if (typeof adm?.objectCount === "number") parts.push(`ADM ${adm.objectCount} 对象`);
  if (typeof d?.trackCount === "number") parts.push(`${d.trackCount} 轨`);
  if (typeof d?.cueCount === "number") parts.push(`${d.cueCount} cue`);
  if (typeof d?.projectRefCount === "number" && (d.projectRefCount as number) > 0)
    parts.push(`${d.projectRefCount} 引用`);
  if (fileSize != null) parts.push(formatBytes(fileSize));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export default function AssetPreviewClient({
  productionId, assetId, versionId, fileName, mimeType, storageType, feishuUrl, userName,
  variant = "page",
}: Props) {
  const embedded = variant === "embedded";
  // 色调：整页=暗房（看片场景）；内嵌=白底（融进知识库 shell）
  const t = embedded ? {
    bar: "border-zinc-200",
    dim: "text-zinc-400 hover:text-zinc-700",
    faint: "text-zinc-400",
    fainter: "text-zinc-300",
    btn: "bg-zinc-800 hover:bg-zinc-700 text-white",
  } : {
    bar: "border-white/5",
    dim: "text-white/40 hover:text-white/70",
    faint: "text-white/30",
    fainter: "text-white/20",
    btn: "bg-white/10 hover:bg-white/20 text-white",
  };
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shareOpen, setShareOpen] = useState(false);
  const [infoLine, setInfoLine] = useState<string | null>(null);
  const [archive, setArchive] = useState<{ entries: ArchiveEntry[]; truncated: boolean; projects: ArchiveProject[] } | null>(null);
  const [showJunk, setShowJunk] = useState(false);
  const [expandedOverride, setExpandedOverride] = useState<Set<string> | null>(null);
  // 包内单 entry 元数据（?entry= 懒算）：path → 摘要/拒绝原因；再点收起
  const [entryMeta, setEntryMeta] = useState<Map<string, { line?: string | null; reason?: string; loading: boolean }>>(new Map());
  // ADM 门（#85）：音频要等元数据判完再挂播放器——ADM 母版（几十声道/GB 级）
  // 喂给 WaveformPlayer 是全量下载+解码失败双输；等待窗口只有一个缓存请求
  const [adm, setAdm] = useState<AdmView | null>(null);
  const [audioMetaReady, setAudioMetaReady] = useState(false);

  const previewType = getPreviewType(mimeType);

  // 树形清单（#85：平铺不符合用户习惯；Mac zip 的 __MACOSX/.DS_Store/._* 默认隐藏，
  // 只是展示层隐藏——数据层清单与 entryCount 保持完整诚实）
  const tree = useMemo(
    () => (archive ? buildArchiveTree(archive.entries, { hideJunk: !showJunk }) : null),
    [archive, showJunk],
  );
  const expanded = useMemo(() => {
    if (expandedOverride) return expandedOverride;
    if (!tree) return new Set<string>();
    // 默认展开态：全展不超过 300 行就全展，否则只见顶层
    const dirs = allDirPaths(tree.roots);
    return flattenTree(tree.roots, new Set(dirs)).length <= 300 ? new Set(dirs) : new Set<string>();
  }, [tree, expandedOverride]);
  const rows = useMemo(() => (tree ? flattenTree(tree.roots, expanded) : []), [tree, expanded]);
  const toggleDir = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path); else next.add(path);
    setExpandedOverride(next);
  };
  const toggleEntryMeta = (path: string, sizeBytes: number | null) => {
    if (entryMeta.has(path)) {
      setEntryMeta((prev) => { const next = new Map(prev); next.delete(path); return next; });
      return;
    }
    setEntryMeta((prev) => new Map(prev).set(path, { loading: true }));
    fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/metadata?entry=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((j: { metadata?: MetaEnvelope | null; reason?: string }) => {
        setEntryMeta((prev) => new Map(prev).set(path, j.metadata
          ? { line: metaInfoLine(j.metadata, sizeBytes), loading: false }
          : { reason: j.reason ?? "无法解析", loading: false }));
      })
      .catch(() => setEntryMeta((prev) => new Map(prev).set(path, { reason: "加载失败", loading: false })));
  };

  // #85 元数据：独立于预览链路拉取（失败静默——信息行是锦上添花不许挡预览）。
  // 压缩包清单：小档案 entries 就在信封里；大档案落了 sidecar，二次 ?full=1 拉回
  useEffect(() => {
    if (storageType !== "r2") { setAudioMetaReady(true); return; } // 无元数据轨的存储：不拦播放器
    const metaUrl = `${BASE_PATH}/api/production/${productionId}/assets/${assetId}/metadata`;
    const pickArchive = (m: MetaEnvelope | null | undefined) => {
      const entries = m?.data?.entries;
      if (Array.isArray(entries) && entries.length > 0)
        setArchive({
          entries: entries as ArchiveEntry[],
          truncated: m?.data?.truncated === true,
          projects: Array.isArray(m?.data?.projects) ? (m.data.projects as ArchiveProject[]) : [],
        });
    };
    fetch(metaUrl)
      .then(r => (r.ok ? r.json() : null))
      .then((j: { fileSize?: number | null; metadata?: MetaEnvelope | null } | null) => {
        if (!j) return;
        setInfoLine(metaInfoLine(j.metadata ?? null, j.fileSize ?? null));
        setAdm(pickAdmView(j.metadata));
        const needFull = j.metadata?.sidecarKey
          && (!Array.isArray(j.metadata?.data?.entries) || (j.metadata?.data?.adm && !Array.isArray(j.metadata?.data?.admObjects)));
        if (Array.isArray(j.metadata?.data?.entries)) pickArchive(j.metadata);
        if (needFull) {
          fetch(`${metaUrl}?full=1`)
            .then(r => (r.ok ? r.json() : null))
            .then((f: { metadata?: MetaEnvelope | null } | null) => {
              pickArchive(f?.metadata);
              const fullAdm = pickAdmView(f?.metadata);
              if (fullAdm) setAdm(fullAdm);
            })
            .catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => setAudioMetaReady(true));
  }, [productionId, assetId, storageType]);

  useEffect(() => {
    // Feishu links: open directly
    if (storageType === "feishu_link" && feishuUrl) {
      window.location.href = feishuUrl;
      return;
    }

    if (!previewType) {
      // Not previewable — fetch download URL and trigger download
      const qs = versionId ? `?v=${versionId}` : "";
      fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/download-url${qs}`)
        .then(r => r.json())
        .then((j: { url?: string }) => {
          if (j.url) { setDownloadUrl(j.url); setLoading(false); }
          else { setError("无法获取下载链接"); setLoading(false); }
        })
        .catch(() => { setError("加载失败"); setLoading(false); });
      return;
    }

    // Previewable — fetch inline URL
    const qs = versionId ? `?v=${versionId}` : "";
    fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/preview-url${qs}`)
      .then(r => r.json())
      .then((j: { url?: string; error?: string }) => {
        if (j.error) { setError(j.error); setLoading(false); return; }
        setUrl(j.url ?? null);
        setLoading(false);
      })
      .catch(() => { setError("加载失败"); setLoading(false); });
  }, [productionId, assetId, versionId, storageType, feishuUrl, previewType]);

  const backHref = `${BASE_PATH}/production/${productionId}/assets`;

  return (
    <div className={embedded
      ? "rounded-xl overflow-hidden border border-zinc-200 bg-white flex flex-col min-h-[calc(100vh-160px)]"
      : "min-h-screen bg-zinc-950 flex flex-col"}>
      {/* Top bar */}
      <div className={`flex items-center justify-between px-4 py-3 border-b shrink-0 ${t.bar}`}>
        {embedded ? (
          <span className="text-xs text-zinc-300">资产预览</span>
        ) : (
          <button
            onClick={() => router.back()}
            className={`text-xs transition-colors ${t.dim}`}
          >
            ← 返回
          </button>
        )}
        <div className="min-w-0 text-center">
          <p className={`text-xs truncate max-w-[50vw] ${embedded ? "text-zinc-600" : "text-white/50"}`}>{fileName}</p>
          {infoLine && <p className={`text-[10px] truncate max-w-[50vw] ${t.faint}`}>{infoLine}</p>}
        </div>
        <div className="flex items-center gap-3">
          {url && (
            <a
              href={url}
              download={fileName}
              className={`text-xs transition-colors ${t.dim}`}
            >
              下载
            </a>
          )}
          {downloadUrl && !url && (
            <a
              href={downloadUrl}
              download={fileName}
              className={`text-xs transition-colors ${t.dim}`}
            >
              下载
            </a>
          )}
          <button
            onClick={() => setShareOpen(true)}
            className={`text-xs transition-colors ${t.dim}`}
          >
            分享
          </button>
          {!embedded && (
            <a
              href={backHref}
              className={`text-xs transition-colors ${t.dim}`}
            >
              Asset 列表
            </a>
          )}
        </div>
      </div>

      {shareOpen && (
        <AssetShareModal
          productionId={productionId}
          assetId={assetId}
          assetName={fileName}
          userName={userName}
          onClose={() => setShareOpen(false)}
        />
      )}

      {/* Content */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0 overflow-auto">
        {loading && (
          <p className={`text-sm ${t.faint}`}>加载中…</p>
        )}

        {!loading && error && (
          <div className="text-center">
            <p className={`text-sm mb-2 ${t.faint}`}>{error}</p>
            <p className={`text-xs ${t.fainter}`}>该格式暂不支持预览</p>
          </div>
        )}

        {!loading && !previewType && downloadUrl && !archive && (
          <div className="text-center">
            <p className="text-4xl mb-4">📄</p>
            <p className={`text-sm mb-1 truncate max-w-xs ${embedded ? "text-zinc-600" : "text-white/50"}`}>{fileName}</p>
            <p className={`text-xs mb-6 ${t.faint}`}>该格式不支持预览</p>
            <a
              href={downloadUrl}
              download={fileName}
              className={`inline-block rounded-lg px-5 py-2.5 text-sm transition-colors ${t.btn}`}
            >
              下载文件
            </a>
          </div>
        )}

        {/* #85：压缩包树形清单（折叠目录 + 系统垃圾默认隐藏；不解压） */}
        {!loading && !previewType && archive && tree && (
          <div className={`w-full max-w-3xl self-start rounded-xl border overflow-hidden ${
            embedded ? "border-zinc-200 bg-white" : "border-white/10 bg-zinc-900"}`}>
            <div className={`flex items-center justify-between px-4 py-2.5 border-b text-xs ${t.bar} ${t.faint}`}>
              <span>
                📦 {tree.visibleFileCount} 个文件
                {archive.truncated && "（清单有截断）"}
              </span>
              <span className="flex items-center gap-3">
                {tree.hiddenCount > 0 && !showJunk && (
                  <button onClick={() => setShowJunk(true)} className={`transition-colors ${t.dim}`}>
                    已隐藏 {tree.hiddenCount} 个系统文件
                  </button>
                )}
                {showJunk && (
                  <button onClick={() => setShowJunk(false)} className={`transition-colors ${t.dim}`}>
                    隐藏系统文件
                  </button>
                )}
                {downloadUrl && (
                  <a href={downloadUrl} download={fileName} className={`transition-colors ${t.dim}`}>下载压缩包</a>
                )}
              </span>
            </div>
            {/* 包内工程：引用体检 + 结构摘要（v4 起 meta 带工程元数据本体） */}
            {archive.projects.length > 0 && (
              <div className={`px-4 py-2 border-b text-xs space-y-1 ${t.bar}`}>
                {archive.projects.map((p, i) => (
                  <p key={i} className={embedded ? "text-zinc-600" : "text-white/60"}>
                    🎛 <span className="font-mono">{p.path}</span>{" "}
                    {p.error
                      ? <span className={t.faint}>解析失败</span>
                      : <>
                          {projectMetaSummary(p.meta) && <span>{projectMetaSummary(p.meta)} · </span>}
                          {(p.missingCount ?? 0) > 0
                            ? <span className="text-amber-500">{p.refCount} 引用 · 缺 {p.missingCount}</span>
                            : <span className={t.faint}>{p.refCount} 引用齐</span>}
                        </>}
                  </p>
                ))}
              </div>
            )}
            <ul className="max-h-[calc(100vh-240px)] overflow-y-auto text-xs font-mono">
              {rows.slice(0, ARCHIVE_RENDER_CAP).map(({ node, depth }) => {
                const em = !node.isDir ? entryMeta.get(node.path) : undefined;
                return (
                  <li key={node.path}
                    className={embedded ? "odd:bg-zinc-50 text-zinc-700" : "odd:bg-white/[0.03] text-white/60"}>
                    <div className="flex items-center gap-2 py-1.5 pr-4" style={{ paddingLeft: 16 + depth * 18 }}>
                      {node.isDir ? (
                        <button onClick={() => toggleDir(node.path)}
                          className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer">
                          <span className={`shrink-0 w-3 ${t.faint}`}>{expanded.has(node.path) ? "▾" : "▸"}</span>
                          <span className="shrink-0">📁</span>
                          <span className="truncate" title={node.path}>{node.name}</span>
                        </button>
                      ) : (
                        <button onClick={() => toggleEntryMeta(node.path, node.entry?.uncompressedBytes ?? null)}
                          className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                          title="查看元数据">
                          <span className="shrink-0 w-3" />
                          <span className="shrink-0">📄</span>
                          <span className="truncate" title={node.path}>{node.name}</span>
                        </button>
                      )}
                      {node.entry?.encrypted && <span className={`shrink-0 ${t.fainter}`}>🔒</span>}
                      {node.sizeBytes > 0 && (
                        <span className={`shrink-0 tabular-nums ${t.faint}`}>{formatBytes(node.sizeBytes)}</span>
                      )}
                    </div>
                    {em && (
                      <div className={`py-1 pr-4 text-[11px] ${t.faint}`} style={{ paddingLeft: 16 + (depth + 1) * 18 + 12 }}>
                        {em.loading ? "解析中…" : em.line ?? `⚠ ${em.reason}`}
                      </div>
                    )}
                  </li>
                );
              })}
              {rows.length > ARCHIVE_RENDER_CAP && (
                <li className={`px-4 py-2 text-center ${t.fainter}`}>
                  …其余 {rows.length - ARCHIVE_RENDER_CAP} 行未渲染（可折叠目录减量）
                </li>
              )}
            </ul>
          </div>
        )}

        {!loading && url && previewType === "image" && (
          <img
            src={url}
            alt={fileName}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            style={{ maxHeight: "calc(100vh - 80px)" }}
          />
        )}

        {!loading && url && previewType === "video" && (
          <Suspense fallback={<p className="text-sm text-white/30">加载中…</p>}>
            <VideoPlayer url={url} fileName={fileName} />
          </Suspense>
        )}

        {/* 音频先过 ADM 门：ADM 母版（多声道对象音频）不许喂波形播放器——身份与
            内容清单才是要交付的（播放留给未来的空间音频前沿），普通音频照旧 */}
        {!loading && url && previewType === "audio" && !audioMetaReady && (
          <p className={`text-sm ${t.faint}`}>读取元数据…</p>
        )}
        {!loading && url && previewType === "audio" && audioMetaReady && !adm && (
          <Suspense fallback={
            <div className="w-full max-w-2xl rounded-2xl bg-zinc-900 px-6 py-8 shadow-2xl flex items-center justify-center h-48">
              <p className="text-sm text-white/30">加载中…</p>
            </div>
          }>
            <WaveformPlayer url={url} fileName={fileName} />
          </Suspense>
        )}

        {/* ADM 面板：①这是个 ADM ②里面有啥（programme / 规格 / 对象清单） */}
        {!loading && previewType === "audio" && adm && (
          <div className={`w-full max-w-3xl self-start rounded-xl border overflow-hidden ${
            embedded ? "border-zinc-200 bg-white" : "border-white/10 bg-zinc-900"}`}>
            <div className={`flex items-center justify-between px-4 py-2.5 border-b text-xs ${t.bar}`}>
              <span className={embedded ? "text-zinc-700" : "text-white/70"}>
                🎚 ADM 母版{adm.programmes[0]?.name ? ` · ${adm.programmes[0].name}` : ""}
              </span>
              {url && (
                <a href={url} download={fileName} className={`transition-colors ${t.dim}`}>下载</a>
              )}
            </div>
            <div className={`px-4 py-2 border-b text-xs ${t.bar} ${t.faint}`}>
              {[
                adm.channels != null && `${adm.channels} 声道`,
                adm.sampleRate != null && adm.bitDepth != null && `${adm.sampleRate / 1000} kHz/${adm.bitDepth} bit`,
                typeof adm.durationSeconds === "number" && formatDuration(adm.durationSeconds),
                `${adm.objectCount} 对象`,
                adm.trackUidCount != null && `${adm.trackUidCount} trackUID`,
              ].filter(Boolean).join(" · ")}
              <span className="ml-2">（对象音频母版，暂不支持在线播放）</span>
            </div>
            {adm.objects.length > 0 && (
              <ul className="max-h-[calc(100vh-280px)] overflow-y-auto text-xs font-mono">
                {adm.objects.map((o, i) => (
                  <li key={i} className={`flex items-center gap-3 px-4 py-1.5 ${
                    embedded ? "odd:bg-zinc-50 text-zinc-700" : "odd:bg-white/[0.03] text-white/60"}`}>
                    <span className="truncate flex-1" title={o.name}>{o.name}</span>
                    {(o.start || o.duration) && (
                      <span className={`shrink-0 tabular-nums ${t.faint}`}>
                        {o.start ?? ""}{o.duration ? ` +${o.duration}` : ""}
                      </span>
                    )}
                  </li>
                ))}
                {adm.objectsTruncated && (
                  <li className={`px-4 py-2 text-center ${t.fainter}`}>…对象清单有截断</li>
                )}
              </ul>
            )}
          </div>
        )}

        {!loading && url && previewType === "pdf" && (
          <iframe
            src={url}
            title={fileName}
            className="w-full rounded-lg shadow-2xl bg-white"
            style={{ height: "calc(100vh - 80px)", width: "min(900px, 100%)" }}
          />
        )}
      </div>
    </div>
  );
}

/** Whether a mimeType / storageType combo has an in-browser preview. Feishu links redirect directly. */
export function isPreviewable(mimeType: string | null, storageType: string): boolean {
  if (storageType === "feishu_link") return true; // redirect to feishu URL
  const t = getPreviewType(mimeType);
  return t !== null;
}
