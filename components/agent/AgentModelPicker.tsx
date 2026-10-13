"use client";
import { useEffect, useRef, useState } from "react";
import DropdownPicker from "@/components/ui/DropdownPicker";
import type {
  AgentModelInfo,
  ModelSelection,
  ThinkingLevel,
  ModelKey,
} from "@/lib/agent/model-types";
const THINKING: Record<ThinkingLevel, string> = {
  off: "关闭思考",
  low: "轻量思考",
  medium: "标准思考",
  high: "深入思考",
  max: "最大思考",
};
const MODALITY = {
  text: "文本",
  image: "图片",
  file: "PDF",
  audio: "音频",
  video: "视频",
};
const COST = { low: "低成本", medium: "中成本", high: "高成本" };
export default function AgentModelPicker({
  sessionKey,
  productionId,
  running,
  ensureSession,
  onSavingChange,
}: {
  sessionKey: string | null;
  productionId: string | null;
  running: boolean;
  ensureSession: () => Promise<string | null>;
  onSavingChange?: (saving: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<AgentModelInfo[]>([]);
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [catalogRevision, setCatalogRevision] = useState(0);
  const saveTarget = useRef<{
    key: string | null;
  } | null>(null);
  const currentContext = useRef({ sessionKey, productionId });
  currentContext.current = { sessionKey, productionId };
  useEffect(() => {
    const controller = new AbortController();
    const pending = saveTarget.current;
    if (pending && (!pending.key || pending.key === sessionKey)) return;
    setSelection(null);
    setCatalog([]);
    setError("");
    const query = sessionKey
      ? `sessionKey=${encodeURIComponent(sessionKey)}`
      : productionId
        ? `productionId=${encodeURIComponent(productionId)}`
        : "";
    void fetch(`/api/agent/models?${query}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "模型目录读取失败");
        if (!controller.signal.aborted && !saveTarget.current) {
          setCatalog(data.models);
          setSelection(data.selection);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : "模型目录读取失败");
      });
    return () => controller.abort();
  }, [sessionKey, productionId, catalogRevision]);
  const save = async (next: ModelSelection) => {
    setSaving(true);
    onSavingChange?.(true);
    setError("");
    const origin = currentContext.current;
    const pending = { key: sessionKey };
    saveTarget.current = pending;
    try {
      const key = await ensureSession();
      if (!key) throw new Error("会话创建失败");
      pending.key = key;
      const response = await fetch(
        `/api/agent/sessions/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelSelection: next }),
        },
      );
      if (!response.ok)
        throw new Error((await response.json()).error ?? "模型选择保存失败");
      if (
        currentContext.current.productionId === origin.productionId &&
        (!currentContext.current.sessionKey ||
          currentContext.current.sessionKey === key)
      )
        setSelection(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "模型选择保存失败");
    } finally {
      if (saveTarget.current === pending) saveTarget.current = null;
      setSaving(false);
      onSavingChange?.(false);
      if (
        currentContext.current.productionId !== origin.productionId ||
        (currentContext.current.sessionKey &&
          currentContext.current.sessionKey !== pending.key)
      )
        setCatalogRevision((value) => value + 1);
    }
  };
  const model = catalog.find((item) => item.key === selection?.modelKey);
  return (
    <div className="mt-2 space-y-1 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1" aria-label="会话模型">
          <DropdownPicker
            value={selection?.modelKey}
            placeholder="选择模型"
            disabled={saving || !selection}
            items={catalog.map((item) => ({
              id: item.key,
              label: `${item.name} · ${COST[item.costTier]}`,
              disabled: !item.available,
              sublabel:
                item.unavailableReason ??
                `${item.input.map((kind) => MODALITY[kind]).join(" / ")} · ${item.description}`,
            }))}
            onChange={(key) => {
              const next = catalog.find((item) => item.key === key);
              if (next && selection)
                void save({
                  ...selection,
                  modelKey: next.key,
                  thinkingLevel: next.thinkingLevels.includes(
                    selection.thinkingLevel,
                  )
                    ? selection.thinkingLevel
                    : next.thinkingLevels[0],
                });
            }}
          />
        </div>
        <div className="min-w-0 flex-1" aria-label="思考强度">
          <DropdownPicker
            value={selection?.thinkingLevel}
            placeholder="思考强度"
            disabled={saving || !selection}
            items={(model?.thinkingLevels ?? []).map((level) => ({
              id: level,
              label: THINKING[level],
            }))}
            onChange={(level) => {
              if (selection && level)
                void save({
                  ...selection,
                  thinkingLevel: level as ThinkingLevel,
                });
            }}
          />
        </div>
      </div>
      <details>
        <summary className="cursor-pointer text-[var(--muted)]">
          子任务模型设置
        </summary>
        <p className="my-1 text-[var(--muted)]">
          未指定时继承主模型。勾选可禁用子任务主动选择。
        </p>
        {catalog.map((item) => (
          <label
            key={item.key}
            className="mr-3 inline-flex items-center gap-1 py-1"
          >
            <input
              type="checkbox"
              disabled={!selection || saving}
              checked={
                selection?.disabledSubagentModels.includes(item.key) ?? false
              }
              onChange={(event) => {
                if (selection)
                  void save({
                    ...selection,
                    disabledSubagentModels: event.target.checked
                      ? [...selection.disabledSubagentModels, item.key]
                      : selection.disabledSubagentModels.filter(
                          (key: ModelKey) => key !== item.key,
                        ),
                  });
              }}
            />
            {item.name}
          </label>
        ))}
      </details>
      {saving && <p className="text-[var(--muted)]">正在保存模型设置…</p>}
      {running && (
        <p className="text-[var(--muted)]">
          修改对下一轮生效，当前回复和插话保持原模型。
        </p>
      )}
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
