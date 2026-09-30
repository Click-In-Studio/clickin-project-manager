"use client";

import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";

import { useState, useRef, useEffect, useCallback } from "react";
import type { AssetType } from "@/lib/asset/db";
import { ASSET_TYPE_LABELS } from "@/lib/asset/types";
import { BASE_PATH } from "@/lib/base-path";
import TreePickerModal from "@/components/ui/TreePickerModal";
import type { NodeEntry } from "@/lib/node/db";
import type { UploadResult } from "@/lib/asset/upload-types";
import { MAX_BROWSER_UPLOAD, runAssetFileUpload, type UploadControl } from "@/lib/asset/upload-client";
import {
  useAssetUploadManager,
  type UploadTaskTarget,
} from "./asset-upload-manager";

type UploadMode = "file" | "feishu";

export type { UploadResult } from "@/lib/asset/upload-types";

/** parentNodeId null＝资产根（树顶层入口的上传落这里，别落成树根散件）。 */
export type UploadPlacement = { parentNodeId: string | null; listable?: boolean };

interface Props {
  productionId: string;
  onUploaded: (result: UploadResult) => void;
  onCancel?: () => void;
  /** 壳节点落点（#420 第二批：树内上传）。缺省＝资产根，行为不变。 */
  placement?: UploadPlacement;
  /** md 文件感知（side feature）：勾选「作为 wiki 文档」时前端直读文本
   *  POST /wiki（走文档管道，不占 R2），结果经 onUploadedWiki 回调。
   *  两者都传才启用开关。 */
  allowMarkdownAsWiki?: boolean;
  onUploadedWiki?: (r: { wikiId: string; nodeId: string; title: string }) => void;
  /** 缺省落点上下文（#420 收官）：挂载面板上传带宿主，服务端解析事件目录等
   *  现成缺省；与 placement/choosePlacement 互斥（显式落点优先）。 */
  landing?: { kind: "mount"; mountType: string; mountId: string };
  /** 资产页模式（#420 第二批）：显示「位置」行让用户挑树落点（缺省「资产」根），
   *  上传一律 listable——工作台上传的东西要在树里看得见。与 placement 互斥，
   *  placement 是调用方钉死落点的形态（树内加号）。 */
  choosePlacement?: boolean;
  /** 追加版本模式（#456）：非空＝为**这个已有资产**传新版本文件，注册打
   *  assets/<id>/files（latest-wins 追加一行 asset_file），而不是创建新资产。
   *  字节通道（presign 直传 / relay 中转）与新建完全一致，只有注册那一步分叉；
   *  面板同时收敛成「只选文件」——类型/落点/显示名都是资产级属性，不该在传第二
   *  个版本时被顺手改掉。 */
  targetAssetId?: string;
  /** 财务凭证复用字节通道，但由 finance 门创建 private single-file asset。 */
  purpose?: "expense_document";
  onBusyChange?: (busy: boolean) => void;
  /** 上传完成后的宿主动作。传入后由 AppShell 上传任务在页面切换后继续收尾。 */
  taskTarget?: UploadTaskTarget;
  /** 任务进入全局队列后立即交还界面；适用于普通资产和已有宿主挂载。 */
  detachOnStart?: boolean;
  onTaskStarted?: (task: { id: string; fileName: string }) => void;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function AssetUploadPanel({
  productionId, onUploaded, onCancel, placement, choosePlacement, landing,
  allowMarkdownAsWiki, onUploadedWiki, targetAssetId, purpose, onBusyChange,
  taskTarget, detachOnStart, onTaskStarted,
}: Props) {
  const uploadManager = useAssetUploadManager();
  // 追加版本模式：注册端点分叉 + 面板收敛（见 Props.targetAssetId）
  const versionMode = !!targetAssetId;
  const expenseDocumentMode = purpose === "expense_document";
  // id null＝服务端缺省（「资产」根锚点懒建）——与列表里挑真「资产」行等价，
  // 名字必须与树里锚点同名，别造第二个称谓
  const [placeTarget, setPlaceTarget] = useState<{ id: string | null; label: string }>({ id: null, label: "资产" });
  const [placePicking, setPlacePicking] = useState(false);
  const [containers, setContainers] = useState<{ id: string; label: string; parentId?: string | null }[] | null>(null);
  const effectivePlacement: UploadPlacement | undefined = choosePlacement
    ? { parentNodeId: placeTarget.id, listable: true }
    : placement;
  const placementFields = effectivePlacement
    ? { ...(effectivePlacement.parentNodeId ? { parentNodeId: effectivePlacement.parentNodeId } : {}),
        listable: effectivePlacement.listable ?? true }
    : landing ? { landing } : {};

  async function openPlacePicker() {
    if (!containers) {
      try {
        const r = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki`);
        const j = await r.json() as { nodes?: NodeEntry[] };
        setContainers((j.nodes ?? [])
          .filter(n => n.kind === "folder" || n.kind === "wiki")
          .map(n => ({ id: n.id, label: n.displayTitle ?? "（无标题）", parentId: n.parentId })));
      } catch { setContainers([]); }
    }
    setPlacePicking(true);
  }
  const [mode, setMode] = useState<UploadMode>("file");
  const [asWiki, setAsWiki] = useState(true);
  const [assetType, setAssetType] = useState<AssetType>("reference");
  const [name, setName] = useState("");
  const [feishuUrl, setFeishuUrl] = useState("");
  const [feishuName, setFeishuName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [transferMode, setTransferMode] = useState<"direct" | "relay">("direct");
  const fileRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0); // track nested dragenter/dragleave to avoid flicker

  const pickFile = useCallback((incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    if (incoming.length > 1) {
      setError("单次只能上传单个文件");
      return;
    }
    setError(null);
    setFile(incoming[0]);
  }, []);

  // Global paste listener — active only in file mode and when not loading
  useEffect(() => {
    if (mode !== "file" || loading) return;
    function onPaste(e: ClipboardEvent) {
      // Ignore paste into text inputs / textareas
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const files = e.clipboardData?.files ?? null;
      if (!files || files.length === 0) return;
      e.preventDefault();
      pickFile(files);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [mode, loading, pickFile]);

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setDragOver(true);
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault(); // required to allow drop
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setDragOver(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    pickFile(e.dataTransfer.files);
  }

  async function handleSubmit() {
    setError(null);
    setLoading(true);
    onBusyChange?.(true);
    setProgress(null);
    setTransferMode("direct");
    try {
      const base = `${BASE_PATH}/api/production/${productionId}/assets`;

      // md → wiki 文档：读文本走文档管道（与树栏「导入」同一约定），不碰 R2
      if (!versionMode && mode === "file" && file && allowMarkdownAsWiki && onUploadedWiki && asWiki
          && /\.(md|markdown)$/i.test(file.name)) {
        const text = await file.text();
        const title = name.trim() || file.name.replace(/\.(md|markdown)$/i, "").trim() || "导入文档";
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title, body: text,
            parentId: effectivePlacement?.parentNodeId ?? null,
            ...(effectivePlacement ? {} : landing ? { landing } : {}),
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError((j as { error?: string }).error ?? `导入失败 (${res.status})`);
          return;
        }
        const w = (j as { wiki: { id: string; nodeId: string } }).wiki;
        onUploadedWiki({ wikiId: w.id, nodeId: w.nodeId, title });
        return;
      }

      if (mode === "feishu" && !versionMode && !expenseDocumentMode) {
        if (!feishuUrl.trim() || !feishuName.trim()) {
          setError("请填写飞书链接和文件名");
          return;
        }
        const res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storageType: "feishu_link",
            feishuUrl: feishuUrl.trim(),
            fileName: feishuName.trim(),
            name: name.trim() || null,
            assetType,
            ...placementFields,
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError((j as { error?: string }).error ?? `上传失败 (${res.status})`);
          return;
        }
        const j = await res.json() as { asset: { id: string; name: string | null; fileName: string; assetType: AssetType; storageType: "r2" | "feishu_link" }; file: { id: string } };
        onUploaded({ assetId: j.asset.id, fileId: j.file.id, name: j.asset.name, fileName: j.asset.fileName, assetType: j.asset.assetType, storageType: j.asset.storageType });
        return;
      }

      if (!file) {
        setError("请选择要上传的文件");
        return;
      }
      if (file.size > MAX_BROWSER_UPLOAD) {
        setError(`文件超过 50 GB 限制（${formatSize(file.size)}），请使用 rclone / rsync 等工具直传 R2`);
        return;
      }

      const execute = (control: UploadControl) => {
        const effectiveControl = detachOnStart ? control : {
          ...control,
          setProgress(value: number | null) {
            setProgress(value);
            control.setProgress(value);
          },
          setTransferMode(value: "direct" | "relay") {
            setTransferMode(value);
            control.setTransferMode(value);
          },
        };
        return runAssetFileUpload(
          {
            productionId,
            file,
            name: name.trim() || null,
            assetType,
            placementFields,
            targetAssetId,
            purpose,
          },
          effectiveControl,
        );
      };

      if (uploadManager) {
        const task = uploadManager.startTask({
          productionId,
          fileName: file.name,
          target: taskTarget,
          executor: execute,
        });
        onTaskStarted?.({ id: task.id, fileName: file.name });
        if (detachOnStart) {
          setFile(null);
          if (fileRef.current) fileRef.current.value = "";
          setName("");
          return;
        }
        const outcome = await task.outcome;
        if (!outcome.ok) {
          setError(outcome.error);
          return;
        }
        onUploaded(outcome.result);
        return;
      }

      const controller = new AbortController();
      const result = await execute({
        signal: controller.signal,
        setProgress,
        setTransferMode,
        setProcessing: () => setProgress(100),
      });
      onUploaded(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      onBusyChange?.(false);
      setProgress(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Mode toggle（追加版本模式无飞书分支：版本文件必须是 R2 字节） */}
      {!versionMode && !expenseDocumentMode && (
      <div className="flex rounded-lg overflow-hidden border border-zinc-200 text-xs">
        {(["file", "feishu"] as UploadMode[]).map(m => (
          <button type="button" key={m} onClick={() => setMode(m)}
            className={`flex-1 py-2 font-medium transition-colors ${
              mode === m ? "bg-zinc-800 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"
            }`}>
            {m === "file" ? "上传文件" : "飞书链接"}
          </button>
        ))}
      </div>
      )}

      {/* key 强制两分支各自重挂：否则 React 按位置把非受控的 file input 复用成
          受控的 text input（uncontrolled→controlled 警告） */}
      {mode === "file" ? (
        <div key="file">
          <div
            onClick={() => fileRef.current?.click()}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-8 cursor-pointer transition-colors ${
              dragOver
                ? "border-zinc-500 bg-zinc-50"
                : "border-zinc-200 hover:border-zinc-400"
            }`}>
            {file ? (
              <>
                <p className="text-sm font-medium text-zinc-700">{file.name}</p>
                <p className="text-xs text-zinc-400">{formatSize(file.size)}</p>
              </>
            ) : dragOver ? (
              <>
                <p className="text-sm text-zinc-500">松开以选择文件</p>
              </>
            ) : (
              <>
                <p className="text-sm text-zinc-400">点击、拖拽或粘贴文件</p>
                <p className="text-xs text-zinc-300">支持所有格式，图片自动生成缩略图</p>
              </>
            )}
          </div>
          <input ref={fileRef} type="file" className="hidden"
            onChange={e => pickFile(e.target.files)} />
          {allowMarkdownAsWiki && onUploadedWiki && file && /\.(md|markdown)$/i.test(file.name) && (
            <label className="mt-2 flex items-center gap-2 text-xs text-zinc-600 cursor-pointer">
              <input type="checkbox" checked={asWiki} onChange={e => setAsWiki(e.target.checked)} />
              作为 wiki 文档导入（可编辑正文，不占用文件存储）
            </label>
          )}
        </div>
      ) : (
        <div key="feishu" className="space-y-2">
          <input
            type="text"
            placeholder="飞书 Wiki 节点链接"
            value={feishuUrl}
            onChange={e => setFeishuUrl(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          />
          <input
            type="text"
            placeholder="文件名（必填）"
            value={feishuName}
            onChange={e => setFeishuName(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          />
        </div>
      )}

      {choosePlacement && !versionMode && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">位置</label>
          <button
            type="button"
            onClick={openPlacePicker}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-left text-zinc-700 hover:border-zinc-400 flex items-center justify-between"
          >
            <span className="truncate">{placeTarget.label}</span>
            <span className="text-xs text-zinc-400 shrink-0 ml-2">更改</span>
          </button>
        </div>
      )}

      {/* Display name（资产级，追加版本不改） */}
      {!versionMode && !expenseDocumentMode && (
      <div>
        <label className="block text-xs text-zinc-400 mb-1.5">显示名称（可选，留空则使用文件名）</label>
        <input
          type="text"
          placeholder={file?.name ?? (feishuName || "例：幕前幕后音响设计图纸 v3")}
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
        />
      </div>
      )}

      {/* Asset type（同上：资产级） */}
      {!versionMode && !expenseDocumentMode && (
      <div>
        <label className="block text-xs text-zinc-400 mb-1.5">类型</label>
        <OverflowSafeSelect
          value={assetType}
          onChange={e => setAssetType(e.target.value as AssetType)}
          className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 bg-white">
          {(Object.entries(ASSET_TYPE_LABELS) as [AssetType, string][])
            .filter(([v]) => v !== "financial_document")
            .map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </OverflowSafeSelect>
      </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      {placePicking && containers && (
        <TreePickerModal
          kicker="Assets"
          title="上传到…"
          items={containers}
          preselected={[]}
          single
          onConfirm={ids => {
            setPlacePicking(false);
            const id = ids[0];
            if (!id) return;
            const c = containers.find(x => x.id === id);
            setPlaceTarget({ id, label: c?.label ?? "已选位置" });
          }}
          onClose={() => setPlacePicking(false)}
        />
      )}

      {/* Upload progress bar */}
      {progress !== null && (
        <div className="space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className="h-full rounded-full bg-zinc-800 transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          {transferMode === "relay" && (
            <p className="text-xs text-amber-600">⚠ 直传受阻，已切换至服务器中转</p>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={loading}
            className="flex-1 rounded-lg border border-zinc-200 py-2 text-sm text-zinc-500 hover:bg-zinc-50 transition-colors">
            取消
          </button>
        )}
        <button type="button" onClick={handleSubmit} disabled={loading}
          className="flex-1 rounded-lg bg-zinc-800 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 transition-colors">
          {loading
            ? progress !== null && progress < 100
              ? `上传中 ${progress}%`
              : "处理中…"
            : versionMode ? "上传新版本" : "确认上传"}
        </button>
      </div>
    </div>
  );
}
