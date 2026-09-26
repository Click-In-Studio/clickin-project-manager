"use client";

// Slash 的二级搜索面板（#692）。「引用…」在四类对象间切换；「嵌入素材」只搜
// 有正文嵌入形态的素材。面板只负责选谁，正文仍只落既有 contentMention / image
// 节点，不引入新方言。

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { BASE_PATH } from "@/lib/base-path";
import { encodeAssetSrc, type ContentMentionAttrs } from "@/lib/editor/mention-types";
import type { SlashPickerMode } from "@/lib/editor/editor-slash-commands";
import type {
  ReferenceSearchKind,
  ReferenceSearchResult,
} from "@/lib/editor/reference-search-types";

const TABS: Array<{ kind: ReferenceSearchKind; label: string }> = [
  { kind: "wiki", label: "文档" },
  { kind: "asset", label: "素材" },
  { kind: "scene", label: "场次" },
  { kind: "cue", label: "Cue" },
];

export function insertReferenceSearchResult(
  editor: Editor,
  result: ReferenceSearchResult,
  mode: SlashPickerMode,
): boolean {
  if (editor.isDestroyed) return false;
  if (mode === "embed") {
    if (result.kind !== "asset" || !editor.state.schema.nodes.image) return false;
    return editor.chain().focus().insertContent({
      type: "image",
      attrs: { src: encodeAssetSrc(result.id), alt: result.label },
    }).run();
  }
  if (!editor.state.schema.nodes.contentMention) return false;
  const attrs = {
    kind: result.kind,
    displayMode: null,
    id: result.id,
    aux: null,
    versionId: null,
    label: result.label,
  } satisfies ContentMentionAttrs & { label: string };
  return editor.chain().focus().insertContent([
    { type: "contentMention", attrs },
    { type: "text", text: " " },
  ]).run();
}

export default function ReferencePicker({
  editor,
  productionId,
  mode,
  onClose,
}: {
  editor: Editor;
  productionId: string;
  mode: SlashPickerMode;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<ReferenceSearchKind>(mode === "embed" ? "asset" : "wiki");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReferenceSearchResult[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    setQuery("");
    setResults([]);
    setActive(0);
    setFailed(false);
  }, [kind]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setLoading(true);
        setFailed(false);
        try {
          const params = new URLSearchParams({ kind, q: trimmed });
          if (mode === "embed") params.set("embeddable", "1");
          const res = await fetch(
            `${BASE_PATH}/api/production/${productionId}/reference-search?${params}`,
            { signal: controller.signal },
          );
          if (!res.ok) throw new Error("search_failed");
          const data = await res.json() as { results?: ReferenceSearchResult[] };
          setResults(data.results ?? []);
          setActive(0);
        } catch (error) {
          if ((error as { name?: string }).name !== "AbortError") {
            setResults([]);
            setFailed(true);
          }
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      })();
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [kind, mode, productionId, query]);

  const pick = (result: ReferenceSearchResult) => {
    if (insertReferenceSearchResult(editor, result, mode)) onClose();
  };

  const panel = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/20 p-4"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === "embed" ? "嵌入素材" : "插入引用"}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl"
      >
        <div className="border-b border-zinc-100 px-4 pt-4">
          <div className="flex items-center justify-between gap-3 pb-3">
            <h2 className="text-sm font-semibold text-zinc-800">
              {mode === "embed" ? "嵌入素材" : "引用…"}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            >
              ×
            </button>
          </div>
          {mode === "reference" && (
            <div role="tablist" aria-label="引用类型" className="flex gap-1">
              {TABS.map(tab => (
                <button
                  key={tab.kind}
                  type="button"
                  role="tab"
                  aria-selected={kind === tab.kind}
                  onClick={() => setKind(tab.kind)}
                  className={`rounded-t-md px-3 py-2 text-xs ${
                    kind === tab.kind
                      ? "bg-amber-50 font-medium text-amber-800"
                      : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-3">
          <div className="relative">
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Escape") { event.preventDefault(); onClose(); }
                else if (event.key === "ArrowDown" && results.length > 0) {
                  event.preventDefault();
                  setActive(value => Math.min(value + 1, results.length - 1));
                } else if (event.key === "ArrowUp" && results.length > 0) {
                  event.preventDefault();
                  setActive(value => Math.max(value - 1, 0));
                } else if (event.key === "Enter" && results[active]) {
                  event.preventDefault();
                  pick(results[active]);
                }
              }}
              placeholder={mode === "embed" ? "按素材名或文件夹搜索" : "输入名字搜索"}
              className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 pr-10 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
            />
            {loading && <span className="absolute right-3 top-2.5 text-sm text-zinc-400">…</span>}
          </div>

          <div className="mt-2 max-h-[50vh] min-h-40 overflow-y-auto rounded-lg border border-zinc-100">
            {!query.trim() ? (
              <p className="px-4 py-10 text-center text-sm text-zinc-400">输入关键词开始搜索</p>
            ) : failed ? (
              <p className="px-4 py-10 text-center text-sm text-red-500">搜索失败，请稍后重试</p>
            ) : !loading && results.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-zinc-400">没有匹配结果</p>
            ) : (
              results.map((result, index) => (
                <button
                  key={`${result.kind}:${result.id}`}
                  type="button"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(result)}
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left ${
                    index === active ? "bg-amber-50" : "hover:bg-zinc-50"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-800">{result.label}</span>
                    {result.description && (
                      <span className="mt-0.5 block truncate text-xs text-zinc-400">{result.description}</span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? null : createPortal(panel, document.body);
}
