"use client";

/**
 * 剧本打印：页盒、分页测量、打印预览与其工具条。
 * 从 ScriptEditor.tsx 整体抽出（#335 阶段 A），逐字未改——先立住模块边界，
 * 拆分与路由化在后续步骤。
 *
 * 对外两个入口：
 *   PrintPreview          —— 屏幕上的打印预览 / 将来的打印路由
 *   PrintPaginationMeasure —— 编辑器在 display.pageBreaks 打开时用它画分页线
 */
import React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync, createPortal } from "react-dom";
import { buildWatermarkTile } from "@/components/watermark-tile";
import ChevronIcon from "@/components/ChevronIcon";
import type { Block, Character, Scene, ScriptTextLayoutMode, PageLayout } from "@/lib/script-types";
import { PAGE_CONFIGS } from "@/lib/script-page";
import { printPageCss } from "@/lib/print-css";
import type { PageConfig } from "@/lib/script-page";
import { listTemplatePresets, paginate, planScript, templateById, type LayoutItem, type Page, type PaginateResult, type ScriptTemplate } from "@/lib/script-template";
import { TemplateItemView, TemplateMeasureLayer, heightOfMeasured, readMeasuredHeights, runPaddingOverrides } from "@/components/print/template-render";
import { useFontsSettled } from "@/components/print/use-fonts-settled";

// ─── Print ────────────────────────────────────────────────────────────────────

const PRINT_TOOLBAR_UNFOLD_BUFFER_PX = 16;
const PRINT_PREVIEW_MIN_SCALE = 0.1;
const PRINT_PREVIEW_MAX_SCALE = 2;
const PRINT_PREVIEW_SIDE_GUTTER_PX = 32;
const PRINT_PREVIEW_PAGE_GUTTER_PX = 64;
const PRINT_PAGINATION_MEASURE_BATCH_SIZE = 32;

type PrintHeaderMode = "all-left" | "all-right" | "first-right" | "first-left";
type PrintToolbarStage = 0 | 1 | 2 | 3;
const PRINT_HEADER_MODES: PrintHeaderMode[] = ["all-left", "all-right", "first-right", "first-left"];
const PRINT_HEADER_MODE_LABELS: Record<PrintHeaderMode, string> = {
  "all-left": "页眉统一靠左",
  "all-right": "页眉统一靠右",
  "first-right": "首页页眉靠右",
  "first-left": "首页页眉靠左",
};

/**
 * 分页的输入：模版 + 规则求值后的 LayoutItem（docs/script-template-engine.md §3）。
 * 预览与编辑器的分页线测量层都从这里拿项，渲染与分页只有引擎这一份。
 */
function usePlannedItems(
  blocks: Block[],
  characters: Character[],
  scenes: Scene[],
  template: ScriptTemplate,
  stageDelimOpen: string,
  stageDelimClose: string,
): LayoutItem[] {
  return useMemo(() => planScript(
    blocks,
    { template, characters, scenes, stageDelimOpen, stageDelimClose },
    { headingOnlyIfSceneKnown: true },
  ), [blocks, characters, scenes, template, stageDelimOpen, stageDelimClose]);
}

function paginateMeasured(
  items: LayoutItem[],
  heights: Record<string, number>,
  contentH: number,
): PaginateResult {
  return paginate(items, { contentHeight: contentH, heightOf: heightOfMeasured(heights), countGapBefore: true });
}

export function samePageMap(a: Record<string, number> | null, b: Record<string, number>): boolean {
  if (!a) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return bKeys.every((key) => a[key] === b[key]);
}

export function PrintPaginationMeasure({
  blocks,
  characters,
  scenes,
  pageLayout,
  stageDelimOpen,
  stageDelimClose,
  textLayoutMode,
  templateId = null,
  onPageMapChange,
}: {
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  pageLayout: PageLayout;
  stageDelimOpen: string;
  stageDelimClose: string;
  textLayoutMode: ScriptTextLayoutMode;
  /** 排版模版预设 id；null = 按 textLayoutMode 回退 */
  templateId?: string | null;
  onPageMapChange: (pageMap: Record<string, number>) => void;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const remeasureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [layoutMeasureTick, setLayoutMeasureTick] = useState(0);
  const measurementGenerationRef = useRef(0);
  const pendingMeasureWorkRef = useRef<{ kind: "idle" | "timer"; id: number } | null>(null);
  const pendingMeasureFrameRef = useRef<number | null>(null);
  const measuredPrintHeightsRef = useRef<Record<string, number>>({});
  const template = templateById(templateId, textLayoutMode);
  const items = usePlannedItems(blocks, characters, scenes, template, stageDelimOpen, stageDelimClose);
  const [measurement, setMeasurement] = useState<{ generation: number; items: LayoutItem[]; batchStart: number } | null>(null);
  const cancelPendingMeasureWork = useCallback(() => {
    const pending = pendingMeasureWorkRef.current;
    if (!pending) return;
    if (pending.kind === "idle") window.cancelIdleCallback(pending.id);
    else window.clearTimeout(pending.id);
    pendingMeasureWorkRef.current = null;
  }, []);
  const cancelPendingMeasureFrame = useCallback(() => {
    if (pendingMeasureFrameRef.current === null) return;
    cancelAnimationFrame(pendingMeasureFrameRef.current);
    pendingMeasureFrameRef.current = null;
  }, []);
  const scheduleMeasureWork = useCallback((work: () => void) => {
    cancelPendingMeasureWork();
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(() => {
        pendingMeasureWorkRef.current = null;
        work();
      }, { timeout: 100 });
      pendingMeasureWorkRef.current = { kind: "idle", id };
      return;
    }
    const id = window.setTimeout(() => {
      pendingMeasureWorkRef.current = null;
      work();
    }, 0);
    pendingMeasureWorkRef.current = { kind: "timer", id };
  }, [cancelPendingMeasureWork]);
  const requestLayoutRemeasure = useCallback(() => {
    if (remeasureTimerRef.current) return;
    remeasureTimerRef.current = setTimeout(() => {
      remeasureTimerRef.current = null;
      setLayoutMeasureTick((tick) => tick + 1);
    }, 0);
  }, []);
  // 字体片到位就重测：用回退字体量出来的分页线是错的（#336 B3）
  useFontsSettled(requestLayoutRemeasure);

  useEffect(() => {
    const generation = ++measurementGenerationRef.current;
    measuredPrintHeightsRef.current = {};
    cancelPendingMeasureFrame();
    scheduleMeasureWork(() => {
      setMeasurement({ generation, items, batchStart: 0 });
    });
    return () => {
      if (remeasureTimerRef.current) {
        clearTimeout(remeasureTimerRef.current);
        remeasureTimerRef.current = null;
      }
      cancelPendingMeasureWork();
      cancelPendingMeasureFrame();
    };
  }, [items, pageLayout, cancelPendingMeasureFrame, cancelPendingMeasureWork, scheduleMeasureWork]);

  useEffect(() => {
    if (!measurement) return;
    if (measurement.generation !== measurementGenerationRef.current) return;
    const total = measurement.items.length;
    if (total === 0) {
      onPageMapChange({});
      setMeasurement((current) => current?.generation === measurementGenerationRef.current ? null : current);
      return;
    }
    const batchEnd = Math.min(total, measurement.batchStart + PRINT_PAGINATION_MEASURE_BATCH_SIZE);
    cancelPendingMeasureFrame();
    pendingMeasureFrameRef.current = requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = requestAnimationFrame(() => {
        pendingMeasureFrameRef.current = null;
        if (measurement.generation !== measurementGenerationRef.current) return;
        const el = measureRef.current;
        if (!el) return;
        readMeasuredHeights(el, measuredPrintHeightsRef.current);
        if (batchEnd < total) {
          scheduleMeasureWork(() => {
            setMeasurement((current) => current?.generation === measurementGenerationRef.current
              ? { ...current, batchStart: batchEnd }
              : current
            );
          });
          return;
        }
        const cfg = PAGE_CONFIGS[pageLayout];
        const result = paginateMeasured(measurement.items, measuredPrintHeightsRef.current, cfg.height - cfg.marginTop - cfg.marginBottom);
        onPageMapChange(result.pageMap);
        setMeasurement((current) => current?.generation === measurementGenerationRef.current ? null : current);
      });
    });
    return cancelPendingMeasureFrame;
  }, [measurement, layoutMeasureTick, pageLayout, cancelPendingMeasureFrame, onPageMapChange, scheduleMeasureWork]);

  if (!measurement) return null;

  const batchEnd = Math.min(measurement.items.length, measurement.batchStart + PRINT_PAGINATION_MEASURE_BATCH_SIZE);
  const cfg = PAGE_CONFIGS[pageLayout];

  return (
    <TemplateMeasureLayer
      items={measurement.items.slice(measurement.batchStart, batchEnd)}
      contentWidth={cfg.width - cfg.marginX * 2}
      stageDelimOpen={stageDelimOpen}
      stageDelimClose={stageDelimClose}
      measureRef={measureRef}
      onLayoutChange={requestLayoutRemeasure}
    />
  );
}


function PrintPage({
  cfg,
  header,
  headerAlign = "left",
  pageNum,
  isToc,
  watermarkTile,
  children,
}: {
  cfg: PageConfig;
  header: string;
  headerAlign?: "left" | "right";
  pageNum: number | null;
  isToc?: boolean;
  watermarkTile?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div
      className="print-page relative bg-white shadow-lg print:shadow-none"
      style={{ width: cfg.width, height: cfg.height }}
    >
      {/* 打印水印：每页一份（fixed overlay 在分页打印下不可靠，逐页内嵌才稳） */}
      {watermarkTile && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 select-none"
          style={{ backgroundImage: watermarkTile, backgroundRepeat: "repeat" }}
        />
      )}
      {/* Header band */}
      <div
        className={`absolute flex items-center border-b border-zinc-100 ${
          headerAlign === "right" ? "justify-end" : "justify-start"
        }`}
        style={{
          top: cfg.marginTop - cfg.headerHeight,
          left: cfg.marginX,
          right: cfg.marginX,
          height: cfg.headerHeight,
        }}
      >
        {!isToc && header && (
          <span className="text-[10px] font-medium tracking-widest text-zinc-400 uppercase">
            {header}
          </span>
        )}
      </div>

      {/* Content area */}
      <div
        className="absolute overflow-hidden"
        style={{
          top: cfg.marginTop,
          bottom: cfg.marginBottom,
          left: cfg.marginX,
          right: cfg.marginX,
        }}
      >
        {children}
      </div>

      {/* Footer band */}
      <div
        className="absolute flex items-center justify-center"
        style={{
          bottom: cfg.marginBottom - cfg.footerHeight,
          left: cfg.marginX,
          right: cfg.marginX,
          height: cfg.footerHeight,
        }}
      >
        {pageNum !== null && (
          <span className="text-xs text-zinc-500">— {pageNum} —</span>
        )}
      </div>
    </div>
  );
}

function PrintHeaderModeMenu({
  headerMode,
  onHeaderModeChange,
}: {
  headerMode: PrintHeaderMode;
  onHeaderModeChange: (mode: PrintHeaderMode) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0" onMouseLeave={() => setOpen(false)}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
        title="选择页眉位置"
      >
        <span>{PRINT_HEADER_MODE_LABELS[headerMode]}</span>
        <ChevronIcon size={12} className="opacity-50" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 w-36 rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-md">
          {PRINT_HEADER_MODES.map((mode) => (
            <button
              key={mode}
              onClick={() => { onHeaderModeChange(mode); setOpen(false); }}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-zinc-50 ${
                headerMode === mode ? "font-medium text-zinc-900" : "text-zinc-500"
              }`}
            >
              <span>{PRINT_HEADER_MODE_LABELS[mode]}</span>
              {headerMode === mode && <span className="text-[10px] text-zinc-900">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 排版模版选择：列出注册表里各家族的最新版本。选中只是**预览**（PrintPreview 里算出新页数
 * 后再保存）——改模版 = 改全局页码，得先看见后果。
 */
function PrintTemplateMenu({
  templateId,
  pendingTemplateId,
  canEdit,
  ready,
  compact,
  stored = false,
  onPick,
}: {
  templateId: string | null;
  pendingTemplateId: string | null | undefined;
  canEdit: boolean;
  ready: boolean;
  compact: boolean;
  stored?: boolean;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const presets = listTemplatePresets();
  const activeId = pendingTemplateId !== undefined ? pendingTemplateId : templateId;
  const active = presets.find((t) => t.id === activeId) ?? null;
  const enabled = canEdit && ready;
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);
  const list = presets.map((t) => (
    <button
      key={t.id}
      type="button"
      disabled={!enabled}
      onClick={() => { onPick(t.id); setOpen(false); }}
      className={`flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-zinc-50 ${
        t.id === activeId ? "font-medium text-zinc-900" : enabled ? "text-zinc-500" : "text-zinc-300"
      }`}
    >
      <span>{t.name}</span>
      {t.id === activeId && <span className="text-[10px] text-zinc-900">✓</span>}
    </button>
  ));
  if (stored) return <>{list}</>;
  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        disabled={!enabled}
        className={`flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${
          enabled ? "text-zinc-600 hover:bg-zinc-100" : "cursor-not-allowed text-zinc-300"
        }`}
        title={!canEdit ? "无权修改剧本排版模版" : ready ? "选择排版模版（所有人共用）" : "打印预览加载中"}
      >
        <span>{compact ? "模版" : `模版：${active?.name ?? "沿用"}`}</span>
        <ChevronIcon size={12} className="opacity-50" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-44 rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-md">
          {list}
        </div>
      )}
    </div>
  );
}

function PrintScaleControl({
  scale,
  fitWidth,
  fitPage,
  onScaleChange,
  onZoomIn,
  onZoomOut,
  onFitWidth,
  onFitPage,
}: {
  scale: number;
  fitWidth: boolean;
  fitPage: boolean;
  onScaleChange: (scale: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitWidth: () => void;
  onFitPage: () => void;
}) {
  const percent = Math.round(scale * 100);
  const [percentDraft, setPercentDraft] = useState(String(percent));
  const [editingPercent, setEditingPercent] = useState(false);
  const fillPercent = ((percent - PRINT_PREVIEW_MIN_SCALE * 100) /
    ((PRINT_PREVIEW_MAX_SCALE - PRINT_PREVIEW_MIN_SCALE) * 100)) * 100;
  useEffect(() => {
    if (!editingPercent) setPercentDraft(String(percent));
  }, [editingPercent, percent]);
  const commitPercent = () => {
    setEditingPercent(false);
    const nextPercent = Number(percentDraft);
    if (Number.isFinite(nextPercent)) onScaleChange(nextPercent / 100);
    else setPercentDraft(String(percent));
  };
  return (
    <div className="space-y-2 px-3 py-2">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>预览缩放</span>
        <label className="flex items-center gap-0.5 text-zinc-700">
          <input
            type="number"
            min={PRINT_PREVIEW_MIN_SCALE * 100}
            max={PRINT_PREVIEW_MAX_SCALE * 100}
            step={1}
            value={percentDraft}
            aria-label="打印预览缩放百分比"
            onFocus={() => setEditingPercent(true)}
            onChange={(event) => setPercentDraft(event.target.value)}
            onBlur={commitPercent}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setPercentDraft(String(percent));
                event.currentTarget.blur();
              }
            }}
            className="print-preview-scale-percent w-14 border-b border-zinc-200 bg-transparent text-right tabular-nums outline-none focus:border-zinc-400"
          />
          <span>%</span>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="缩小打印预览"
          title="缩小"
          onClick={onZoomOut}
          disabled={scale <= PRINT_PREVIEW_MIN_SCALE}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-base leading-none text-[#637ca1] hover:bg-zinc-100 disabled:text-zinc-300"
        >
          −
        </button>
        <input
          type="range"
          min={PRINT_PREVIEW_MIN_SCALE * 100}
          max={PRINT_PREVIEW_MAX_SCALE * 100}
          step={1}
          value={percent}
          aria-label="打印预览缩放"
          onChange={(event) => onScaleChange(Number(event.target.value) / 100)}
          className="print-preview-scale-slider-v2 block min-w-0 flex-1 cursor-pointer"
          style={{ "--print-preview-scale-fill": `${fillPercent}%` } as React.CSSProperties}
        />
        <button
          type="button"
          aria-label="放大打印预览"
          title="放大"
          onClick={onZoomIn}
          disabled={scale >= PRINT_PREVIEW_MAX_SCALE}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-base leading-none text-[#637ca1] hover:bg-zinc-100 disabled:text-zinc-300"
        >
          +
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <button
          type="button"
          onClick={onFitWidth}
          disabled={fitWidth}
          className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-50"
        >
          适合宽度
        </button>
        <button
          type="button"
          onClick={onFitPage}
          disabled={fitPage}
          className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-50"
        >
          适合整页
        </button>
      </div>
    </div>
  );
}

function PrintScaleMenu({
  scale,
  fitWidth,
  fitPage,
  shortLabel,
  onScaleChange,
  onZoomIn,
  onZoomOut,
  onFitWidth,
  onFitPage,
}: {
  scale: number;
  fitWidth: boolean;
  fitPage: boolean;
  shortLabel: boolean;
  onScaleChange: (scale: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitWidth: () => void;
  onFitPage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const percent = Math.round(scale * 100);
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);
  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`flex items-center justify-between gap-1 whitespace-nowrap rounded-md px-2 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 ${
          shortLabel ? "w-[68px]" : "w-24"
        }`}
        title="调整打印预览缩放"
      >
        <span>{shortLabel ? `${percent}%` : `缩放 ${percent}%`}</span>
        <ChevronIcon size={12} className="opacity-50" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-48 rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-md">
          <PrintScaleControl
            scale={scale}
            fitWidth={fitWidth}
            fitPage={fitPage}
            onScaleChange={onScaleChange}
            onZoomIn={onZoomIn}
            onZoomOut={onZoomOut}
            onFitWidth={onFitWidth}
            onFitPage={onFitPage}
          />
        </div>
      )}
    </div>
  );
}

function PrintPageSettingsMenu({
  ellipsis = false,
  templateId,
  pendingTemplateId,
  canEditTemplate,
  printPreviewReady,
  headerMode,
  previewScale,
  previewScaleFitWidth,
  previewScaleFitPage,
  onTemplatePick,
  onHeaderModeChange,
  onPreviewScaleChange,
  onPreviewZoomIn,
  onPreviewZoomOut,
  onPreviewFitWidth,
  onPreviewFitPage,
}: {
  ellipsis?: boolean;
  templateId: string | null;
  pendingTemplateId: string | null | undefined;
  canEditTemplate: boolean;
  printPreviewReady: boolean;
  headerMode: PrintHeaderMode;
  previewScale: number;
  previewScaleFitWidth: boolean;
  previewScaleFitPage: boolean;
  onTemplatePick: (id: string) => void;
  onHeaderModeChange: (mode: PrintHeaderMode) => void;
  onPreviewScaleChange: (scale: number) => void;
  onPreviewZoomIn: () => void;
  onPreviewZoomOut: () => void;
  onPreviewFitWidth: () => void;
  onPreviewFitPage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);
  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={ellipsis ? "更多页面设置" : undefined}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={ellipsis
          ? "flex h-8 w-8 items-center justify-center rounded-md text-base font-bold text-zinc-500 transition-colors hover:bg-zinc-100"
          : "flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
        }
      >
        {ellipsis ? (
          <span aria-hidden="true">⋮</span>
        ) : (
          <>
            页面设置
            <ChevronIcon size={12} className="opacity-50" />
          </>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-48 rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-md">
          <p className="px-3 pb-1 pt-1 text-[10px] font-medium tracking-wide text-zinc-400">排版模版</p>
          <PrintTemplateMenu
            stored
            compact={false}
            templateId={templateId}
            pendingTemplateId={pendingTemplateId}
            canEdit={canEditTemplate}
            ready={printPreviewReady}
            onPick={onTemplatePick}
          />
          <div className="my-1 border-t border-zinc-100" />
          <p className="px-3 pb-1 pt-1 text-[10px] font-medium tracking-wide text-zinc-400">页眉位置</p>
          {PRINT_HEADER_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onHeaderModeChange(mode)}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-zinc-50 ${
                headerMode === mode ? "font-medium text-zinc-900" : "text-zinc-500"
              }`}
            >
              <span>{PRINT_HEADER_MODE_LABELS[mode]}</span>
              {headerMode === mode && <span className="text-[10px] text-zinc-900">✓</span>}
            </button>
          ))}
          <div className="my-1 border-t border-zinc-100" />
          <PrintScaleControl
            scale={previewScale}
            fitWidth={previewScaleFitWidth}
            fitPage={previewScaleFitPage}
            onScaleChange={onPreviewScaleChange}
            onZoomIn={onPreviewZoomIn}
            onZoomOut={onPreviewZoomOut}
            onFitWidth={onPreviewFitWidth}
            onFitPage={onPreviewFitPage}
          />
        </div>
      )}
    </div>
  );
}

export default function PrintPreview({
  blocks,
  characters,
  scenes,
  pageLayout,
  stageDelimOpen,
  stageDelimClose,
  textLayoutMode,
  templateId,
  canEditTemplate,
  onTemplateSave,
  onClose,
  watermarkText,
  standalone = false,
}: {
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  pageLayout: PageLayout;
  stageDelimOpen: string;
  stageDelimClose: string;
  /** 无 templateId 时的回退依据 */
  textLayoutMode: ScriptTextLayoutMode;
  /** 已保存的排版模版预设 id（null = 按 textLayoutMode 回退） */
  templateId: string | null;
  canEditTemplate: boolean;
  /** 保存模版选择；resolve false = 失败（调用方已回滚） */
  onTemplateSave: (id: string | null) => Promise<boolean>;
  onClose: () => void;
  /** 访问者水印文案（服务端下发，通常是「用户名 邮箱」）。null = 不打水印。 */
  watermarkText: string | null;
  /** 打印路由用：本组件就是整个页面，不需要 portal 逃出 app shell，
   *  也不需要 fixed 覆盖层。同时开启 printReady 信号。 */
  standalone?: boolean;
}) {
  const cfg = PAGE_CONFIGS[pageLayout];
  const contentW = cfg.width - cfg.marginX * 2;
  const contentH = cfg.height - cfg.marginTop - cfg.marginBottom;
  // 改模版 = 改全局页码：选中先只当预览（pendingTemplateId），算出新页数后由人决定保存还是撤销
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null | undefined>(undefined);
  const activeTemplateId = pendingTemplateId !== undefined ? pendingTemplateId : templateId;
  const template = templateById(activeTemplateId, textLayoutMode);
  const [savedPageCount, setSavedPageCount] = useState<number | null>(null);

  const measureRef = useRef<HTMLDivElement>(null);
  const items = usePlannedItems(blocks, characters, scenes, template, stageDelimOpen, stageDelimClose);
  const [data, setData] = useState<{
    pages: Page[];
    scenePageNums: Record<string, number>;
    templateId: string;
    measureTick: number;
  } | null>(null);
  const [forceLoadingNotice, setForceLoadingNotice] = useState(false);
  const forceLoadingNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remeasureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [layoutMeasureTick, setLayoutMeasureTick] = useState(0);
  const [headerMode, setHeaderMode] = useState<PrintHeaderMode>("first-right");
  const [printToolbarStage, setPrintToolbarStage] = useState<PrintToolbarStage>(0);

  // 打印强制水印：访问者 [用户名 邮箱]（无视项目屏幕水印开关）。
  // 由服务端下发而非客户端 fetch /api/me——那条路有竞态（点得快就会出一份
  // 无水印的片子），而水印是安全特性，不能取决于一次请求赢没赢。
  const watermarkTile = useMemo(
    () => (watermarkText ? buildWatermarkTile(watermarkText) : null),
    [watermarkText],
  );

  // 打印时隐藏 app shell：portal 到 body，globals.css 以 body:has(.script-print-root)
  // 判定（不能用 JS 挂 body class——body className 由 React 管理会被协调抹掉）
  const printToolbarRef = useRef<HTMLDivElement>(null);
  const printToolbarRequiredWidthRef = useRef<Partial<Record<PrintToolbarStage, number>>>({});
  const previewViewportRef = useRef<HTMLDivElement>(null);
  const [fitPreviewScales, setFitPreviewScales] = useState({ width: 1, page: 1 });
  const [previewFitMode, setPreviewFitMode] = useState<"width" | "page">("width");
  const [customPreviewScale, setCustomPreviewScale] = useState<number | null>(null);
  const previewScale = customPreviewScale ?? fitPreviewScales[previewFitMode];
  const previewScaleFitWidth = customPreviewScale === null && previewFitMode === "width";
  const previewScaleFitPage = customPreviewScale === null && previewFitMode === "page";
  const setPreviewScale = useCallback((scale: number) => {
    const clamped = Math.min(PRINT_PREVIEW_MAX_SCALE, Math.max(PRINT_PREVIEW_MIN_SCALE, scale));
    setCustomPreviewScale(Math.round(clamped * 100) / 100);
  }, []);
  const adjustPreviewScale = useCallback((delta: number) => {
    setCustomPreviewScale((current) => {
      const scale = current ?? fitPreviewScales[previewFitMode];
      const clamped = Math.min(PRINT_PREVIEW_MAX_SCALE, Math.max(PRINT_PREVIEW_MIN_SCALE, scale + delta));
      return Math.round(clamped * 100) / 100;
    });
  }, [fitPreviewScales, previewFitMode]);
  const fitPreviewWidth = useCallback(() => {
    setPreviewFitMode("width");
    setCustomPreviewScale(null);
  }, []);
  const fitPreviewPage = useCallback(() => {
    setPreviewFitMode("page");
    setCustomPreviewScale(null);
  }, []);
  const requestLayoutRemeasure = useCallback(() => {
    if (remeasureTimerRef.current) return;
    remeasureTimerRef.current = setTimeout(() => {
      remeasureTimerRef.current = null;
      setData(null);
      setLayoutMeasureTick((tick) => tick + 1);
    }, 0);
  }, []);
  // 字体片到位就重测，且就绪信号只在字体全部就位后的那次测量之后才发（#336 B3）
  const fontsSettled = useFontsSettled(requestLayoutRemeasure);

  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const heights = readMeasuredHeights(el);
    const result = paginateMeasured(items, heights, contentH);
    setData({
      pages: result.pages,
      scenePageNums: result.scenePageNums,
      templateId: template.id,
      measureTick: layoutMeasureTick,
    });
  }, [items, contentW, contentH, template.id, layoutMeasureTick]);

  const printPreviewReady = !!data &&
    data.templateId === template.id &&
    data.measureTick === layoutMeasureTick;

  // 记住已保存模版的页数，预览新模版时对照
  useEffect(() => {
    if (printPreviewReady && pendingTemplateId === undefined && data) setSavedPageCount(data.pages.length);
  }, [printPreviewReady, pendingTemplateId, data]);
  const showLoadingNotice = forceLoadingNotice || !printPreviewReady;

  // 打印路由的就绪信号：字体全部就位 **且** 之后的分页测量已完成。无头浏览器等
  // 这个属性，不必 sleep 赌时间。以前是「量完再等 fonts.ready」——那个 promise
  // 往往在测量层挂上去之前就解析过了，量出来的仍是回退字体的换行点；现在字体
  // 每到位一次就重测（useFontsSettled），fontsSettled 为真时 data 一定是字体
  // 就位后量的。（水印不在条件里——它由服务端随首屏下发，不存在"还没到"的状态。）
  useEffect(() => {
    if (!standalone) return;
    if (!printPreviewReady || !fontsSettled) return;
    document.body.dataset.printReady = "1";
    return () => {
      delete document.body.dataset.printReady;
    };
  }, [standalone, printPreviewReady, fontsSettled]);

  useLayoutEffect(() => {
    const viewport = previewViewportRef.current;
    if (!viewport) return;
    const updateFitScale = () => {
      const availableWidth = Math.max(1, viewport.clientWidth - PRINT_PREVIEW_SIDE_GUTTER_PX);
      const widthScale = Math.min(1, Math.max(
        PRINT_PREVIEW_MIN_SCALE,
        Math.floor((availableWidth / cfg.width) * 100) / 100,
      ));
      const availableHeight = Math.max(1, viewport.clientHeight - PRINT_PREVIEW_SIDE_GUTTER_PX);
      const pageScale = Math.min(widthScale, Math.max(
        PRINT_PREVIEW_MIN_SCALE,
        Math.floor((availableHeight / (cfg.height + PRINT_PREVIEW_PAGE_GUTTER_PX)) * 100) / 100,
      ));
      setFitPreviewScales((current) => (
        Math.abs(current.width - widthScale) < 0.001 && Math.abs(current.page - pageScale) < 0.001
          ? current
          : { width: widthScale, page: pageScale }
      ));
    };
    updateFitScale();
    const observer = new ResizeObserver(updateFitScale);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [cfg.height, cfg.width]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        adjustPreviewScale(0.05);
      } else if (event.key === "-") {
        event.preventDefault();
        adjustPreviewScale(-0.05);
      } else if (event.key === "0") {
        event.preventDefault();
        fitPreviewWidth();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [adjustPreviewScale, fitPreviewWidth]);

  const handlePreviewWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    adjustPreviewScale(event.deltaY < 0 ? 0.05 : -0.05);
  };

  const measurePrintToolbar = useCallback(() => {
    const toolbar = printToolbarRef.current;
    if (!toolbar) return;
    const required = toolbar.scrollWidth;
    const available = toolbar.clientWidth;
    if (required > available + 1 && printToolbarStage < 3) {
      printToolbarRequiredWidthRef.current[printToolbarStage] = required;
      setPrintToolbarStage((printToolbarStage + 1) as PrintToolbarStage);
      return;
    }
    if (printToolbarStage > 0) {
      const previous = (printToolbarStage - 1) as PrintToolbarStage;
      const previousRequiredWidth = printToolbarRequiredWidthRef.current[previous];
      if (previousRequiredWidth && available >= previousRequiredWidth + PRINT_TOOLBAR_UNFOLD_BUFFER_PX) {
        setPrintToolbarStage(previous);
      }
    }
  }, [printToolbarStage]);

  useLayoutEffect(() => {
    measurePrintToolbar();
  }, [measurePrintToolbar, headerMode, canEditTemplate, printPreviewReady, previewScale, pendingTemplateId]);

  useEffect(() => {
    const toolbar = printToolbarRef.current;
    if (!toolbar) return;
    let frame: number | null = null;
    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measurePrintToolbar();
      });
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(toolbar);
    for (const child of toolbar.children) {
      if (child instanceof HTMLElement) observer.observe(child);
    }
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [measurePrintToolbar]);

  useEffect(() => {
    if (!forceLoadingNotice || !printPreviewReady) return;
    if (forceLoadingNoticeTimerRef.current) clearTimeout(forceLoadingNoticeTimerRef.current);
    forceLoadingNoticeTimerRef.current = setTimeout(() => {
      setForceLoadingNotice(false);
      forceLoadingNoticeTimerRef.current = null;
    }, 250);
  }, [forceLoadingNotice, printPreviewReady]);

  useEffect(() => {
    return () => {
      if (forceLoadingNoticeTimerRef.current) clearTimeout(forceLoadingNoticeTimerRef.current);
      if (layoutSwitchTimerRef.current) clearTimeout(layoutSwitchTimerRef.current);
      if (remeasureTimerRef.current) clearTimeout(remeasureTimerRef.current);
    };
  }, []);

  const previewTemplate = (id: string) => {
    if (!canEditTemplate || !printPreviewReady) return;
    if (id === activeTemplateId) return;
    flushSync(() => {
      setForceLoadingNotice(true);
      setData(null);
    });
    if (layoutSwitchTimerRef.current) clearTimeout(layoutSwitchTimerRef.current);
    layoutSwitchTimerRef.current = setTimeout(() => {
      layoutSwitchTimerRef.current = null;
      setPendingTemplateId(id === templateId ? undefined : id);
    }, 0);
  };
  const [savingTemplate, setSavingTemplate] = useState(false);
  const commitTemplate = async () => {
    if (pendingTemplateId === undefined || savingTemplate) return;
    setSavingTemplate(true);
    const ok = await onTemplateSave(pendingTemplateId);
    setSavingTemplate(false);
    if (ok) setPendingTemplateId(undefined);
  };
  const discardTemplate = () => {
    if (pendingTemplateId === undefined) return;
    flushSync(() => {
      setForceLoadingNotice(true);
      setData(null);
    });
    setPendingTemplateId(undefined);
  };

  const getHeaderAlign = (pageNum: number): "left" | "right" => {
    if (headerMode === "all-left") return "left";
    if (headerMode === "all-right") return "right";
    const firstPageRight = headerMode === "first-right";
    return pageNum % 2 === (firstPageRight ? 1 : 0) ? "right" : "left";
  };

  // Scenes in document order for TOC
  const tocScenes: Scene[] = [];
  for (const b of blocks) {
    if (b.sceneId) {
      const s = scenes.find((sc) => sc.id === b.sceneId);
      if (s && !tocScenes.some((ts) => ts.id === s.id)) tocScenes.push(s);
    }
  }

  // standalone（打印路由）用 h-full：root layout 的 body 是 h-full overflow-hidden，
  // 内部 previewViewport 自己滚。fixed inset-0 是嵌在编辑器里时用来盖住 app shell 的，
  // 配合 globals.css 的 body:has(.script-print-root) 在 @media print 下隐藏兄弟子树。
  const root = (
    <div className={`script-print-root ${standalone ? "h-full" : "fixed inset-0 z-50"} flex flex-col bg-zinc-300 print:static print:block print:bg-white`}>
      {/* 纸张尺寸随版式注入：@page size 只能写在 CSS 里，而版式是每个演出自配的。
          原先 globals.css 硬编码 A4，letter / 双排版式打出来对不上纸。 */}
      <style dangerouslySetInnerHTML={{ __html: printPageCss(cfg) }} />
      {/* Preview toolbar */}
      <div ref={printToolbarRef} className="flex shrink-0 flex-nowrap items-center overflow-visible border-b border-zinc-200 bg-white px-2 py-3 sm:px-6 print:hidden">
        <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-zinc-700">打印预览</span>
        <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-1 sm:gap-3">
          {printToolbarStage < 2 ? (
            <>
              <PrintHeaderModeMenu headerMode={headerMode} onHeaderModeChange={setHeaderMode} />
              <PrintTemplateMenu
                templateId={templateId}
                pendingTemplateId={pendingTemplateId}
                canEdit={canEditTemplate}
                ready={printPreviewReady}
                compact={printToolbarStage === 1}
                onPick={previewTemplate}
              />
              <PrintScaleMenu
                scale={previewScale}
                fitWidth={previewScaleFitWidth}
                fitPage={previewScaleFitPage}
                shortLabel={printToolbarStage === 1}
                onScaleChange={setPreviewScale}
                onZoomIn={() => adjustPreviewScale(0.05)}
                onZoomOut={() => adjustPreviewScale(-0.05)}
                onFitWidth={fitPreviewWidth}
                onFitPage={fitPreviewPage}
              />
            </>
          ) : printToolbarStage === 2 ? (
            <PrintPageSettingsMenu
              templateId={templateId}
              pendingTemplateId={pendingTemplateId}
              canEditTemplate={canEditTemplate}
              printPreviewReady={printPreviewReady}
              headerMode={headerMode}
              previewScale={previewScale}
              previewScaleFitWidth={previewScaleFitWidth}
              previewScaleFitPage={previewScaleFitPage}
              onTemplatePick={previewTemplate}
              onHeaderModeChange={setHeaderMode}
              onPreviewScaleChange={setPreviewScale}
              onPreviewZoomIn={() => adjustPreviewScale(0.05)}
              onPreviewZoomOut={() => adjustPreviewScale(-0.05)}
              onPreviewFitWidth={fitPreviewWidth}
              onPreviewFitPage={fitPreviewPage}
            />
          ) : null}
          <button
            onClick={() => window.print()}
            className="shrink-0 whitespace-nowrap rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 sm:px-4"
          >
            {printToolbarStage === 0 ? "打印 / 导出 PDF" : "导出"}
          </button>
          <button
            onClick={onClose}
            className="shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 sm:px-3"
          >
            关闭
          </button>
          {printToolbarStage === 3 && (
            <PrintPageSettingsMenu
              ellipsis
              templateId={templateId}
              pendingTemplateId={pendingTemplateId}
              canEditTemplate={canEditTemplate}
              printPreviewReady={printPreviewReady}
              headerMode={headerMode}
              previewScale={previewScale}
              previewScaleFitWidth={previewScaleFitWidth}
              previewScaleFitPage={previewScaleFitPage}
              onTemplatePick={previewTemplate}
              onHeaderModeChange={setHeaderMode}
              onPreviewScaleChange={setPreviewScale}
              onPreviewZoomIn={() => adjustPreviewScale(0.05)}
              onPreviewZoomOut={() => adjustPreviewScale(-0.05)}
              onPreviewFitWidth={fitPreviewWidth}
              onPreviewFitPage={fitPreviewPage}
            />
          )}
        </div>
      </div>

      {/* 模版预览未保存：先把页数变化摆在人眼前，再决定 */}
      {pendingTemplateId !== undefined && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 print:hidden sm:px-6">
          <span>
            预览中：<span className="font-medium">{template.name}</span>
            {printPreviewReady && data
              ? <>——共 <span className="font-medium tabular-nums">{data.pages.length}</span> 页{savedPageCount !== null && savedPageCount !== data.pages.length && <>（当前模版 {savedPageCount} 页，<span className="font-medium">所有人的页码都会变</span>）</>}</>
              : "，正在重新分页…"}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <button type="button" onClick={discardTemplate} className="rounded-md px-2 py-1 text-amber-800 hover:bg-amber-100">撤销</button>
            <button type="button" onClick={commitTemplate} disabled={!printPreviewReady || savingTemplate} className="rounded-md bg-amber-700 px-3 py-1 font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50">
              {savingTemplate ? "保存中…" : "保存为剧本模版"}
            </button>
          </span>
        </div>
      )}

      {/* Scrollable page stack */}
      <div
        ref={previewViewportRef}
        onWheel={handlePreviewWheel}
        className="relative flex-1 overflow-auto print:overflow-visible print:h-auto"
      >
        {showLoadingNotice && (
          <div className="pointer-events-none fixed inset-x-0 bottom-0 top-14 z-[60] flex items-center justify-center bg-zinc-300 print:hidden">
            <span className="rounded-md border border-zinc-200 bg-white/95 px-4 py-2 text-sm font-medium text-zinc-500 shadow-lg">
              加载中...
            </span>
          </div>
        )}
        <TemplateMeasureLayer
          items={items}
          contentWidth={contentW}
          stageDelimOpen={stageDelimOpen}
          stageDelimClose={stageDelimClose}
          measureRef={measureRef}
          onLayoutChange={requestLayoutRemeasure}
        />
        <div
          className="print-preview-pages mx-auto flex flex-col items-center gap-6 py-8 print:gap-0 print:py-0"
          style={{ "--print-preview-scale": previewScale } as React.CSSProperties}
        >

          {/* TOC page */}
          {tocScenes.length > 0 && (
            <PrintPage cfg={cfg} header="" pageNum={null} isToc watermarkTile={watermarkTile}>
              <div className="pt-6">
                <h1 className="mb-10 text-center text-base font-bold tracking-[0.25em] text-zinc-700">
                  目录
                </h1>
                <div className="flex flex-col gap-3">
                  {tocScenes.map((scene) => (
                    <div key={scene.id} className="flex items-baseline gap-2">
                      <span className="min-w-[4rem] text-sm font-bold text-zinc-500">
                        {scene.number || "—"}
                      </span>
                      <span className="text-sm text-zinc-600">{scene.name}</span>
                      <span className="mx-2 mb-1 flex-1 border-b border-dotted border-zinc-300" />
                      <span className="min-w-[2rem] text-right text-sm tabular-nums text-zinc-400">
                        {data?.scenePageNums[scene.id] ?? "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </PrintPage>
          )}

          {/* Content pages */}
          {data?.pages.map((page, idx) => {
            const paddingOverrides = runPaddingOverrides(page.items);
            return (
              <PrintPage
                key={idx}
                cfg={cfg}
                header={page.sceneLabel}
                headerAlign={getHeaderAlign(page.pageNum)}
                pageNum={page.pageNum}
                watermarkTile={watermarkTile}
              >
                {page.items.map((placed) => (
                  <TemplateItemView
                    key={placed.item.id}
                    item={placed.item}
                    variant={placed.variant}
                    gapBefore={placed.gapBefore}
                    paddingOverride={paddingOverrides.get(placed.item.id)}
                    stageDelimOpen={stageDelimOpen}
                    stageDelimClose={stageDelimClose}
                  />
                ))}
              </PrintPage>
            );
          })}
        </div>
      </div>
    </div>
  );

  // 打印路由里本组件就是整页，没有 app shell 要逃，直接渲染；
  // 嵌在编辑器里时仍需 portal 到 body，靠 globals.css 的
  // body:has(.script-print-root) 隐藏其余兄弟子树。
  return standalone ? root : createPortal(root, document.body);
}
