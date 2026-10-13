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
  const [nextTurnHint, setNextTurnHint] = useState(false);
  useEffect(() => { if (!running) setNextTurnHint(false); }, [running]);
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
      ) {
        setSelection(next);
        if (running) setNextTurnHint(true);
      }
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
    <div className="agent-model-controls">
      <div className="agent-model-control" aria-label="会话模型">
        <DropdownPicker
          appearance="text"
          searchableAfter={8}
          value={selection?.modelKey}
          placeholder="选择模型"
          disabled={saving || !selection}
          items={catalog.map((item) => ({
            id: item.key,
            label: item.name,
            disabled: !item.available,
            sublabel: `${COST[item.costTier]} · ${item.unavailableReason ??
              `${item.input.map((kind) => MODALITY[kind]).join(" / ")} · ${item.description}`}`,
          }))}
          onChange={(key) => {
            const next = catalog.find((item) => item.key === key);
            if (next && selection)
              void save({
                ...selection,
                modelKey: next.key,
                thinkingLevel: next.thinkingLevels.includes(selection.thinkingLevel)
                  ? selection.thinkingLevel
                  : next.thinkingLevels[0],
              });
          }}
          footer={
            <details className="agent-model-advanced">
              <summary>子任务模型设置</summary>
              <p>未指定时继承主模型。勾选可禁用子任务主动选择。</p>
              {catalog.map((item) => (
                <label key={item.key}>
                  <input
                    type="checkbox"
                    disabled={!selection || saving}
                    checked={selection?.disabledSubagentModels.includes(item.key) ?? false}
                    onChange={(event) => {
                      if (selection)
                        void save({
                          ...selection,
                          disabledSubagentModels: event.target.checked
                            ? [...selection.disabledSubagentModels, item.key]
                            : selection.disabledSubagentModels.filter((key: ModelKey) => key !== item.key),
                        });
                    }}
                  />
                  {item.name}
                </label>
              ))}
            </details>
          }
        />
      </div>
      <div className="agent-thinking-control" aria-label="思考强度">
        <DropdownPicker
          appearance="text"
          searchableAfter={8}
          value={selection?.thinkingLevel}
          placeholder="思考强度"
          disabled={saving || !selection}
          items={(model?.thinkingLevels ?? []).map((level) => ({ id: level, label: THINKING[level] }))}
          onChange={(level) => {
            if (selection && level)
              void save({ ...selection, thinkingLevel: level as ThinkingLevel });
          }}
        />
      </div>
      {saving && <span role="status" aria-label="正在保存模型设置" title="正在保存模型设置" className="animate-spin">↻</span>}
      {nextTurnHint && <span className="agent-model-hint" title="修改对下一轮生效，当前回复和插话保持原模型。">下轮生效</span>}
      {error && <p role="alert" className="agent-model-error">{error}</p>}
    </div>
  );
}
