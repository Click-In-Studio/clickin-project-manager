"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { CueList } from "@/lib/ops/cue-list-types";
import { colorFor } from "./colors";

export default function ExportModal({
  cueLists,
  defaultSelectedIds,
  productionId,
  onClose,
}: {
  cueLists: CueList[];
  defaultSelectedIds: Set<string>;
  productionId: string;
  onClose: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState(() => new Set(defaultSelectedIds));
  const [wikiUrl, setWikiUrl] = useState("");
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [log, setLog] = useState<string[]>([]);
  const [errMsg, setErrMsg] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const toggle = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const runExport = useCallback(async () => {
    setPhase("running");
    setLog([]);
    setErrMsg("");
    const addLog = (msg: string) => setLog(prev => [...prev, msg]);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/export-cues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cueListIds: [...selectedIds], wikiUrl: wikiUrl.trim() }),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        setPhase("error");
        setErrMsg(text || `HTTP ${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        let event = "log";
        for (const line of lines) {
          if (line.startsWith("event: ")) { event = line.slice(7).trim(); continue; }
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (event === "log") addLog(data);
            if (event === "done") { setPhase("done"); break outer; }
            if (event === "error") { setPhase("error"); setErrMsg(data); break outer; }
          }
        }
      }
    } catch (e) {
      setPhase("error");
      setErrMsg((e as Error).message ?? "未知错误");
    }
  }, [selectedIds, wikiUrl, productionId]);

  const busy = phase === "running";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-zinc-700">导出 Cue</h2>

        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-zinc-400">选择 Cue 表</p>
          <div className="flex flex-wrap gap-1.5">
            {cueLists.map((cl, i) => {
              const c = colorFor(i);
              const on = selectedIds.has(cl.id);
              return (
                <button
                  key={cl.id}
                  onClick={() => toggle(cl.id)}
                  disabled={busy}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-all disabled:opacity-50 ${
                    on ? `${c.bg} text-white` : "bg-zinc-100 text-zinc-400 hover:bg-zinc-200"
                  }`}
                >
                  {cl.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-xs text-zinc-400">飞书电子表格 Wiki 链接</p>
          <input
            type="text"
            value={wikiUrl}
            onChange={e => setWikiUrl(e.target.value)}
            placeholder="https://xxx.feishu.cn/wiki/…"
            disabled={busy}
            className="text-xs border border-zinc-200 rounded-lg px-3 py-2 outline-none focus:border-zinc-400 disabled:bg-zinc-50"
          />
        </div>

        {phase !== "idle" && (
          <div
            ref={logRef}
            className="bg-zinc-50 rounded-lg p-3 text-xs font-mono text-zinc-600 max-h-36 overflow-y-auto flex flex-col gap-0.5"
          >
            {log.map((line, i) => <span key={i}>{line}</span>)}
            {phase === "error" && <span className="text-red-500">✗ {errMsg}</span>}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="text-xs text-zinc-400 hover:text-zinc-600 px-3 py-1.5"
          >
            {phase === "done" ? "关闭" : "取消"}
          </button>
          {phase !== "done" && (
            <button
              onClick={runExport}
              disabled={busy || selectedIds.size === 0 || !wikiUrl.trim()}
              className="text-xs bg-zinc-800 text-white rounded-lg px-4 py-1.5 hover:bg-zinc-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "导出中…" : "导出"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
