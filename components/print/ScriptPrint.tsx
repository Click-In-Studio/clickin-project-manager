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
import { BASE_PATH } from "@/lib/base-path";
import ChevronIcon from "@/components/ChevronIcon";
import type { Block, Character, Scene, ScriptTextLayoutMode, PageLayout } from "@/lib/script-types";
import { PAGE_CONFIGS } from "@/lib/script-page";
import type { PageConfig } from "@/lib/script-page";
import ModeSwitch from "@/components/ModeSwitch";
import { mdToHtml } from "@/lib/script-md";
import { isSceneBoundaryBlock, isTextBlock, shouldHideCharacterLabel, shouldShowCharacterGap } from "@/lib/script-block-layout";

// ─── Print ────────────────────────────────────────────────────────────────────

type PrintItem =
  | { kind: "sceneHeader"; scene: Scene }
  | { kind: "block"; block: Block; hideChar: boolean; leadingCharacterGap: boolean };

const PRINT_CHAR_NAME_HEIGHT = 22;
const PRINT_CHARACTER_GAP_HEIGHT = 10;
const PRINT_WRAPPER_PADDING_HEIGHT = 8;
const PRINT_TEXT_CLASS = "w-full break-words text-sm leading-7";
const PRINT_STAGE_COMMENT_CLASS = "font-stage text-sm italic leading-7 text-zinc-400 whitespace-pre-wrap";
const PRINT_COMPACT_CHARACTER_OPTICAL_OFFSET_PX: number = 1;
const PRINT_TOOLBAR_UNFOLD_BUFFER_PX = 16;
const PRINT_PREVIEW_MIN_SCALE = 0.1;
const PRINT_PREVIEW_MAX_SCALE = 2;
const PRINT_PREVIEW_SIDE_GUTTER_PX = 32;
const PRINT_PREVIEW_PAGE_GUTTER_PX = 64;
const PRINT_PAGINATION_MEASURE_BATCH_SIZE = 32;

type PrintPaginationMeasurement = {
  generation: number;
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  pageLayout: PageLayout;
  stageDelimOpen: string;
  stageDelimClose: string;
  textLayoutMode: ScriptTextLayoutMode;
  batchStart: number;
};

type PrintPageData = {
  items: PrintItem[];
  sceneLabel: string;
  pageNum: number;
};
type PrintHeaderMode = "all-left" | "all-right" | "first-right" | "first-left";
type PrintToolbarStage = 0 | 1 | 2 | 3;
const PRINT_HEADER_MODES: PrintHeaderMode[] = ["all-left", "all-right", "first-right", "first-left"];
const PRINT_HEADER_MODE_LABELS: Record<PrintHeaderMode, string> = {
  "all-left": "页眉统一靠左",
  "all-right": "页眉统一靠右",
  "first-right": "首页页眉靠右",
  "first-left": "首页页眉靠左",
};

function computePrintPages(
  blocks: Block[],
  scenes: Scene[],
  heights: Record<string, number>,
  contentH: number
): { pages: PrintPageData[]; scenePageNums: Record<string, number> } {
  const pages: PrintPageData[] = [];
  const scenePageNums: Record<string, number> = {};
  let curItems: PrintItem[] = [];
  let curH = 0;
  let curLabel = "";
  let activeSceneLabel = "";
  let pageNum = 1;
  let curHasBlock = false;
  let prevTextBlock: Block | null = null;

  const flush = () => {
    if (curItems.length === 0) return;
    pages.push({ items: [...curItems], sceneLabel: curLabel, pageNum });
    pageNum++;
    curItems = [];
    curH = 0;
    curLabel = "";
    curHasBlock = false;
  };

  const addItem = (item: PrintItem, h: number) => {
    const forcedCharHeight = item.kind === "block" && item.hideChar && item.block.characterIds.length > 0
      ? PRINT_CHAR_NAME_HEIGHT + PRINT_WRAPPER_PADDING_HEIGHT
      : 0;
    let firstBlockOnPage = item.kind === "block" && !curHasBlock;
    const leadingGapHeight = item.kind === "block" && item.leadingCharacterGap && !firstBlockOnPage
      ? PRINT_CHARACTER_GAP_HEIGHT
      : 0;
    let nextH = h + leadingGapHeight + (firstBlockOnPage ? forcedCharHeight : 0);
    if (curH + nextH > contentH && curItems.length > 0) {
      flush();
      firstBlockOnPage = item.kind === "block";
      nextH = h + (firstBlockOnPage ? forcedCharHeight : 0);
    }
    const nextItem = firstBlockOnPage
      ? { ...item, hideChar: false, leadingCharacterGap: false }
      : item;
    curItems.push(nextItem);
    curH += nextH;
    if (item.kind === "block") {
      if (!curHasBlock) curLabel = activeSceneLabel;
      curHasBlock = true;
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!isTextBlock(block)) continue;
    const prev = prevTextBlock;
    const hideChar = shouldHideCharacterLabel(prev, block);
    const leadingCharacterGap = shouldShowCharacterGap(prev, block, hideChar);

    if (!block.sceneId) {
      activeSceneLabel = "";
    } else if (block.sceneId !== prev?.sceneId) {
      const scene = scenes.find((s) => s.id === block.sceneId);
      if (scene) {
        activeSceneLabel = scene.number;
        addItem({ kind: "sceneHeader", scene }, heights[`sh-${block.sceneId}`] ?? 52);
        if (!(scene.id in scenePageNums)) scenePageNums[scene.id] = pageNum;
      } else {
        activeSceneLabel = "";
      }
    }

    addItem({ kind: "block", block, hideChar, leadingCharacterGap }, heights[`b-${block.id}`] ?? 60);
    prevTextBlock = block;
  }

  flush();
  return { pages, scenePageNums };
}

function pageMapFromPrintPages(pages: PrintPageData[]): Record<string, number> {
  const pageMap: Record<string, number> = {};
  for (const page of pages) {
    for (const item of page.items) {
      if (item.kind === "block") pageMap[item.block.id] = page.pageNum;
    }
  }
  return pageMap;
}

export function samePageMap(a: Record<string, number> | null, b: Record<string, number>): boolean {
  if (!a) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return bKeys.every((key) => a[key] === b[key]);
}

function PrintMeasurementLayer({
  blocks,
  characters,
  scenes,
  contentW,
  compactLayout,
  stageDelimOpen,
  stageDelimClose,
  measureRef,
  onLayoutChange,
  blockRange,
}: {
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  contentW: number;
  compactLayout: boolean;
  stageDelimOpen: string;
  stageDelimClose: string;
  measureRef: React.RefObject<HTMLDivElement | null>;
  onLayoutChange?: () => void;
  blockRange?: { start: number; end: number };
}) {
  const characterById = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);
  const sceneById = useMemo(() => new Map(scenes.map((scene) => [scene.id, scene])), [scenes]);
  const allMeasuredBlocks = useMemo(() => blocks.filter(isTextBlock), [blocks]);
  const rangeStart = blockRange?.start ?? 0;
  const rangeEnd = blockRange?.end ?? allMeasuredBlocks.length;
  const measuredBlocks = allMeasuredBlocks.slice(rangeStart, rangeEnd);

  const renderSceneHeader = (scene: Scene) => (
    <div className="flex items-center gap-3 py-3">
      <div className="h-px flex-1 bg-zinc-200" />
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-bold tracking-widest text-zinc-400">{scene.number}</span>
        {scene.name && <span className="text-sm text-zinc-500">{scene.name}</span>}
      </div>
      <div className="h-px flex-1 bg-zinc-200" />
    </div>
  );

  const renderBlock = (block: Block, hideChar: boolean) => {
    const isStage = block.type === "stage";
    const sel = block.characterIds
      .map((id) => characterById.get(id))
      .filter((c): c is Character => !!c);
    const blockPaddingClass = isStage ? "py-0" : hideChar ? "py-0" : "py-1";
    const characterLabel = sel.map((c) => {
      const ann = block.characterAnnotations[c.id];
      return ann ? `${c.name}（${ann}）` : c.name;
    }).join("、");

    if (compactLayout && !isStage) {
      const stageCommentText = sel.length > 0 && block.stageComment?.trim()
        ? block.stageComment.trim()
            .split(/\r\n|\r|\n/)
            .map((line) => `${stageDelimOpen}${line}${stageDelimClose}`)
            .join("\n")
        : "";
      return (
        <CompactPrintBlock
          block={block}
          blockPaddingClass={blockPaddingClass}
          characterLabel={characterLabel}
          showCharacterLabel={!hideChar && sel.length > 0}
          stageCommentText={stageCommentText}
          leadingCharacterGap={false}
          stageDelimOpen={stageDelimOpen}
          stageDelimClose={stageDelimClose}
          onLayoutChange={onLayoutChange}
        />
      );
    }

    const content = !isStage && sel.length > 0 && block.stageComment?.trim()
      ? `${block.stageComment.trim().split(/\r\n|\r|\n/).map((line) => `${stageDelimOpen}${line}${stageDelimClose}`).join("\n")}\n${block.content}`
      : block.content;

    return (
      <div className={`w-full ${blockPaddingClass}`}>
        {!isStage && !hideChar && sel.length > 0 && (
          <div className="mb-0.5 w-full text-center text-sm font-bold tracking-[0.12em] text-zinc-800">
            {characterLabel}
          </div>
        )}
        <div
          className={`${PRINT_TEXT_CLASS} ${
            isStage
              ? "font-stage text-left italic text-zinc-500"
              : block.lyric
              ? "font-lyric text-center font-bold uppercase text-zinc-800"
              : "font-script text-center text-zinc-800"
          }`}
          dangerouslySetInnerHTML={{ __html: mdToHtml(content, stageDelimOpen, stageDelimClose) || "　" }}
        />
      </div>
    );
  };

  return (
    <div
      ref={measureRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        left: -9999,
        top: 0,
        width: contentW,
        visibility: "hidden",
      }}
    >
      {measuredBlocks.map((block, i) => {
        const prev = allMeasuredBlocks[rangeStart + i - 1] ?? null;
        const hideChar = shouldHideCharacterLabel(prev, block);
        const sceneStart = isSceneBoundaryBlock(block, prev);
        return (
          <div key={block.id}>
            {sceneStart && (() => {
              const sceneId = block.sceneId;
              if (sceneId === null) return null;
              const scene = sceneById.get(sceneId);
              return scene ? (
                <div data-mid={`sh-${sceneId}`}>
                  {renderSceneHeader(scene)}
                </div>
              ) : null;
            })()}
            <div data-mid={`b-${block.id}`}>{renderBlock(block, hideChar)}</div>
          </div>
        );
      })}
    </div>
  );
}

export function PrintPaginationMeasure({
  blocks,
  characters,
  scenes,
  pageLayout,
  stageDelimOpen,
  stageDelimClose,
  textLayoutMode,
  onPageMapChange,
}: {
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  pageLayout: PageLayout;
  stageDelimOpen: string;
  stageDelimClose: string;
  textLayoutMode: ScriptTextLayoutMode;
  onPageMapChange: (pageMap: Record<string, number>) => void;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const remeasureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [layoutMeasureTick, setLayoutMeasureTick] = useState(0);
  const measurementGenerationRef = useRef(0);
  const pendingMeasureWorkRef = useRef<{ kind: "idle" | "timer"; id: number } | null>(null);
  const pendingMeasureFrameRef = useRef<number | null>(null);
  const measuredPrintHeightsRef = useRef<Record<string, number>>({});
  const [measurement, setMeasurement] = useState<PrintPaginationMeasurement | null>(null);
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

  useEffect(() => {
    const generation = ++measurementGenerationRef.current;
    measuredPrintHeightsRef.current = {};
    cancelPendingMeasureFrame();
    scheduleMeasureWork(() => {
      setMeasurement({
        generation,
        blocks: blocks.filter(isTextBlock),
        characters,
        scenes,
        pageLayout,
        stageDelimOpen,
        stageDelimClose,
        textLayoutMode,
        batchStart: 0,
      });
    });
    return () => {
      if (remeasureTimerRef.current) {
        clearTimeout(remeasureTimerRef.current);
        remeasureTimerRef.current = null;
      }
      cancelPendingMeasureWork();
      cancelPendingMeasureFrame();
    };
  }, [blocks, characters, scenes, pageLayout, stageDelimOpen, stageDelimClose, textLayoutMode, cancelPendingMeasureFrame, cancelPendingMeasureWork, scheduleMeasureWork]);

  useEffect(() => {
    if (!measurement) return;
    if (measurement.generation !== measurementGenerationRef.current) return;
    const textBlockCount = measurement.blocks.length;
    if (textBlockCount === 0) {
      onPageMapChange({});
      setMeasurement((current) => current?.generation === measurementGenerationRef.current
        ? null
        : current
      );
      return;
    }
    const batchEnd = Math.min(
      textBlockCount,
      measurement.batchStart + PRINT_PAGINATION_MEASURE_BATCH_SIZE,
    );
    cancelPendingMeasureFrame();
    pendingMeasureFrameRef.current = requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = requestAnimationFrame(() => {
        pendingMeasureFrameRef.current = null;
        if (measurement.generation !== measurementGenerationRef.current) return;
        const el = measureRef.current;
        if (!el) return;
        el.querySelectorAll<HTMLElement>("[data-mid]").forEach((node) => {
          if (node.dataset.mid) measuredPrintHeightsRef.current[node.dataset.mid] = node.offsetHeight;
        });
        if (batchEnd < textBlockCount) {
          scheduleMeasureWork(() => {
            setMeasurement((current) => current?.generation === measurementGenerationRef.current
              ? { ...current, batchStart: batchEnd }
              : current
            );
          });
          return;
        }
        const measurementCfg = PAGE_CONFIGS[measurement.pageLayout];
        const measurementContentH = measurementCfg.height - measurementCfg.marginTop - measurementCfg.marginBottom;
        const result = computePrintPages(
          measurement.blocks,
          measurement.scenes,
          measuredPrintHeightsRef.current,
          measurementContentH,
        );
        onPageMapChange(pageMapFromPrintPages(result.pages));
        setMeasurement((current) => current?.generation === measurementGenerationRef.current
          ? null
          : current
        );
      });
    });
    return cancelPendingMeasureFrame;
  }, [measurement, layoutMeasureTick, cancelPendingMeasureFrame, onPageMapChange, scheduleMeasureWork]);

  if (!measurement) return null;

  const batchEnd = Math.min(
    measurement.blocks.length,
    measurement.batchStart + PRINT_PAGINATION_MEASURE_BATCH_SIZE,
  );

  return (
    <PrintMeasurementLayer
      blocks={measurement.blocks}
      characters={measurement.characters}
      scenes={measurement.scenes}
      contentW={PAGE_CONFIGS[measurement.pageLayout].width - PAGE_CONFIGS[measurement.pageLayout].marginX * 2}
      compactLayout={measurement.textLayoutMode === "compact"}
      stageDelimOpen={measurement.stageDelimOpen}
      stageDelimClose={measurement.stageDelimClose}
      measureRef={measureRef}
      onLayoutChange={requestLayoutRemeasure}
      blockRange={{ start: measurement.batchStart, end: batchEnd }}
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

function PrintCompactLayoutControl({
  compactLayout,
  canEdit,
  ready,
  label,
  stored = false,
  onToggle,
}: {
  compactLayout: boolean;
  canEdit: boolean;
  ready: boolean;
  label: string;
  stored?: boolean;
  onToggle: () => void;
}) {
  const enabled = canEdit && ready;
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={!enabled}
      className={`flex items-center gap-2 whitespace-nowrap text-sm transition-colors ${
        stored ? "w-full justify-between px-3 py-2" : "shrink-0 rounded-md px-3 py-1.5"
      } ${enabled ? "text-zinc-600 hover:bg-zinc-100" : "cursor-not-allowed text-zinc-300"}`}
      title={
        !canEdit
          ? "无权修改剧本排版模式"
          : ready
            ? "保存为所有人共用的剧本排版模式"
            : "打印预览加载中"
      }
    >
      <span>{label}</span>
      <ModeSwitch active={compactLayout} activeClassName="bg-[#637ca1]" />
    </button>
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
  compactLayout,
  canEditTextLayout,
  printPreviewReady,
  headerMode,
  previewScale,
  previewScaleFitWidth,
  previewScaleFitPage,
  onTextLayoutModeToggle,
  onHeaderModeChange,
  onPreviewScaleChange,
  onPreviewZoomIn,
  onPreviewZoomOut,
  onPreviewFitWidth,
  onPreviewFitPage,
}: {
  ellipsis?: boolean;
  compactLayout: boolean;
  canEditTextLayout: boolean;
  printPreviewReady: boolean;
  headerMode: PrintHeaderMode;
  previewScale: number;
  previewScaleFitWidth: boolean;
  previewScaleFitPage: boolean;
  onTextLayoutModeToggle: () => void;
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
          <PrintCompactLayoutControl
            compactLayout={compactLayout}
            canEdit={canEditTextLayout}
            ready={printPreviewReady}
            label="紧凑排版"
            stored
            onToggle={onTextLayoutModeToggle}
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

function getElementLineBounds(el: HTMLElement): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  range.detach();

  if (rects.length === 0) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? [rect] : [];
  }

  const lines: DOMRect[] = [];
  for (const rect of rects) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(rect.top - last.top) < 2) {
      const left = Math.min(last.left, rect.left);
      const top = Math.min(last.top, rect.top);
      const right = Math.max(last.right, rect.right);
      const bottom = Math.max(last.bottom, rect.bottom);
      lines[lines.length - 1] = new DOMRect(left, top, right - left, bottom - top);
    } else {
      lines.push(new DOMRect(rect.left, rect.top, rect.width, rect.height));
    }
  }
  return lines;
}

function CompactPrintBlock({
  block,
  blockPaddingClass,
  characterLabel,
  showCharacterLabel,
  stageCommentText,
  leadingCharacterGap,
  stageDelimOpen,
  stageDelimClose,
  onLayoutChange,
}: {
  block: Block;
  blockPaddingClass: string;
  characterLabel: string;
  showCharacterLabel: boolean;
  stageCommentText: string;
  leadingCharacterGap: boolean;
  stageDelimOpen: string;
  stageDelimClose: string;
  onLayoutChange?: () => void;
}) {
  const characterColumnRef = useRef<HTMLDivElement | null>(null);
  const firstLineRef = useRef<HTMLDivElement | null>(null);
  const lastNotifiedOffsetRef = useRef(0);
  const [firstLineOffset, setFirstLineOffset] = useState(0);

  useLayoutEffect(() => {
    const characterEl = characterColumnRef.current;
    const firstLineEl = firstLineRef.current;
    if (!characterEl || !firstLineEl || !showCharacterLabel) {
      setFirstLineOffset((prev) => {
        if (prev === 0) return prev;
        return 0;
      });
      return;
    }

    const characterLines = getElementLineBounds(characterEl);
    const firstLines = getElementLineBounds(firstLineEl);
    const targetLine = characterLines[characterLines.length - 1];
    const currentLine = firstLines[0];
    if (!targetLine || !currentLine) return;

    const targetCenter = targetLine.top + targetLine.height / 2 - PRINT_COMPACT_CHARACTER_OPTICAL_OFFSET_PX;
    const currentCenter = currentLine.top + currentLine.height / 2;
    const nextOffset = Math.max(
      0,
      Math.round(firstLineOffset + targetCenter - currentCenter)
    );

    setFirstLineOffset((prev) => {
      if (Math.abs(prev - nextOffset) < 1) return prev;
      return nextOffset;
    });
  }, [block.id, characterLabel, showCharacterLabel, stageCommentText, firstLineOffset]);

  useEffect(() => {
    if (!onLayoutChange) return;
    if (lastNotifiedOffsetRef.current === firstLineOffset) return;
    lastNotifiedOffsetRef.current = firstLineOffset;
    onLayoutChange();
  }, [firstLineOffset, onLayoutChange]);

  const firstLineStyle: React.CSSProperties | undefined = firstLineOffset > 0
    ? { marginTop: firstLineOffset }
    : undefined;
  const characterLabelStyle: React.CSSProperties | undefined =
    PRINT_COMPACT_CHARACTER_OPTICAL_OFFSET_PX !== 0
      ? { transform: `translateY(${PRINT_COMPACT_CHARACTER_OPTICAL_OFFSET_PX}px)` }
      : undefined;

  return (
    <div key={block.id} className={`w-full ${blockPaddingClass}`}>
      {leadingCharacterGap && <div className="h-2.5" aria-hidden="true" />}
      <div className="grid grid-cols-[7.5rem_1rem_minmax(0,1fr)] items-start gap-x-2 text-left">
        <div className="col-start-1 row-start-1 min-w-0 text-right">
          {showCharacterLabel && (
            <div
              ref={characterColumnRef}
              style={characterLabelStyle}
              className="max-w-full break-words text-sm font-bold leading-7 tracking-[0.12em] text-zinc-800"
            >
              {characterLabel}
            </div>
          )}
        </div>
        {stageCommentText && (
          <div
            ref={firstLineRef}
            style={firstLineStyle}
            className={`col-start-3 row-start-1 self-start ${PRINT_STAGE_COMMENT_CLASS}`}
          >
            {stageCommentText}
          </div>
        )}
        <div
          ref={stageCommentText ? undefined : firstLineRef}
          style={stageCommentText ? undefined : firstLineStyle}
          className={`col-start-3 min-w-0 ${stageCommentText ? "row-start-2" : "row-start-1"} ${PRINT_TEXT_CLASS} ${
            block.lyric
              ? "font-lyric font-bold uppercase text-zinc-800"
              : "font-script text-zinc-800"
          }`}
          dangerouslySetInnerHTML={{ __html: mdToHtml(block.content, stageDelimOpen, stageDelimClose) || "　" }}
        />
      </div>
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
  canEditTextLayout,
  onTextLayoutModeChange,
  onClose,
}: {
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  pageLayout: PageLayout;
  stageDelimOpen: string;
  stageDelimClose: string;
  textLayoutMode: ScriptTextLayoutMode;
  canEditTextLayout: boolean;
  onTextLayoutModeChange: (mode: ScriptTextLayoutMode) => void;
  onClose: () => void;
}) {
  const cfg = PAGE_CONFIGS[pageLayout];
  const contentW = cfg.width - cfg.marginX * 2;
  const contentH = cfg.height - cfg.marginTop - cfg.marginBottom;
  const compactLayout = textLayoutMode === "compact";

  const measureRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<{
    pages: PrintPageData[];
    scenePageNums: Record<string, number>;
    layoutMode: ScriptTextLayoutMode;
    measureTick: number;
  } | null>(null);
  const [forceLoadingNotice, setForceLoadingNotice] = useState(false);
  const forceLoadingNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remeasureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [layoutMeasureTick, setLayoutMeasureTick] = useState(0);
  const [headerMode, setHeaderMode] = useState<PrintHeaderMode>("first-right");
  const [printToolbarStage, setPrintToolbarStage] = useState<PrintToolbarStage>(0);

  // 打印强制水印：访问者 [用户名 邮箱]（无视项目屏幕水印开关）
  const [watermarkTile, setWatermarkTile] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE_PATH}/api/me`)
      .then((r) => r.json())
      .then((me: { name: string | null; email: string | null }) => {
        if (cancelled || !me.name) return;
        setWatermarkTile(buildWatermarkTile(me.email ? `${me.name} ${me.email}` : me.name));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

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

  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const heights: Record<string, number> = {};
    el.querySelectorAll<HTMLElement>("[data-mid]").forEach((node) => {
      if (node.dataset.mid) heights[node.dataset.mid] = node.offsetHeight;
    });
    setData({
      ...computePrintPages(blocks, scenes, heights, contentH),
      layoutMode: textLayoutMode,
      measureTick: layoutMeasureTick,
    });
  }, [blocks, characters, scenes, contentW, contentH, textLayoutMode, stageDelimOpen, stageDelimClose, layoutMeasureTick]);

  const printPreviewReady = !!data &&
    data.layoutMode === textLayoutMode &&
    data.measureTick === layoutMeasureTick;
  const showLoadingNotice = forceLoadingNotice || !printPreviewReady;

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
  }, [measurePrintToolbar, headerMode, canEditTextLayout, printPreviewReady, previewScale]);

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

  const handleTextLayoutModeToggle = () => {
    if (!canEditTextLayout || !printPreviewReady) return;
    const nextLayoutMode = compactLayout ? "center" : "compact";
    flushSync(() => {
      setForceLoadingNotice(true);
      setData(null);
    });
    if (layoutSwitchTimerRef.current) clearTimeout(layoutSwitchTimerRef.current);
    layoutSwitchTimerRef.current = setTimeout(() => {
      layoutSwitchTimerRef.current = null;
      onTextLayoutModeChange(nextLayoutMode);
    }, 0);
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

  const renderSceneHeader = (scene: Scene, key: string) => (
    <div key={key} className="flex items-center gap-3 py-3">
      <div className="h-px flex-1 bg-zinc-200" />
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-bold tracking-widest text-zinc-400">{scene.number}</span>
        {scene.name && <span className="text-sm text-zinc-500">{scene.name}</span>}
      </div>
      <div className="h-px flex-1 bg-zinc-200" />
    </div>
  );

  const renderBlock = (
    block: Block,
    hideChar: boolean,
    leadingCharacterGap = false,
    continuesToHiddenCharacter = false,
    endsHiddenCharacterRun = false,
    measureLayout = false,
  ) => {
    const isStage = block.type === "stage";
    const sel = characters.filter((c) => block.characterIds.includes(c.id));
    const blockPaddingClass = isStage
      ? "py-0"
      : hideChar
        ? endsHiddenCharacterRun ? "pt-0 pb-1" : "py-0"
        : continuesToHiddenCharacter ? "pt-1 pb-0" : "py-1";
    const characterLabel = sel.map((c) => {
      const ann = block.characterAnnotations[c.id];
      return ann ? `${c.name}（${ann}）` : c.name;
    }).join("、");

    if (compactLayout && !isStage) {
      const stageCommentText = sel.length > 0 && block.stageComment?.trim()
        ? block.stageComment.trim()
            .split(/\r\n|\r|\n/)
            .map((line) => `${stageDelimOpen}${line}${stageDelimClose}`)
            .join("\n")
        : "";
      return (
        <CompactPrintBlock
          key={block.id}
          block={block}
          blockPaddingClass={blockPaddingClass}
          characterLabel={characterLabel}
          showCharacterLabel={!hideChar && sel.length > 0}
          stageCommentText={stageCommentText}
          leadingCharacterGap={leadingCharacterGap}
          stageDelimOpen={stageDelimOpen}
          stageDelimClose={stageDelimClose}
          onLayoutChange={measureLayout ? requestLayoutRemeasure : undefined}
        />
      );
    }

    const content = !isStage && sel.length > 0 && block.stageComment?.trim()
      ? `${block.stageComment.trim().split(/\r\n|\r|\n/).map((line) => `${stageDelimOpen}${line}${stageDelimClose}`).join("\n")}\n${block.content}`
      : block.content;

    return (
      <div key={block.id} className={`w-full ${blockPaddingClass}`}>
        {leadingCharacterGap && <div className="h-2.5" aria-hidden="true" />}
        {!isStage && !hideChar && sel.length > 0 && (
          <div className="mb-0.5 w-full text-center text-sm font-bold tracking-[0.12em] text-zinc-800">
            {characterLabel}
          </div>
        )}
        <div
          className={`${PRINT_TEXT_CLASS} ${
            isStage
              ? "font-stage text-left italic text-zinc-500"
              : block.lyric
              ? "font-lyric text-center font-bold uppercase text-zinc-800"
              : "font-script text-center text-zinc-800"
          }`}
          dangerouslySetInnerHTML={{ __html: mdToHtml(content, stageDelimOpen, stageDelimClose) || "　" }}
        />
      </div>
    );
  };

  // portal 到 body：@media print 下按 body class 隐藏 shell 兄弟子树（globals.css）
  return createPortal(
    <div className="script-print-root fixed inset-0 z-50 flex flex-col bg-zinc-300 print:static print:block print:bg-white">
      {/* Preview toolbar */}
      <div ref={printToolbarRef} className="flex shrink-0 flex-nowrap items-center overflow-visible border-b border-zinc-200 bg-white px-2 py-3 sm:px-6 print:hidden">
        <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-zinc-700">打印预览</span>
        <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-1 sm:gap-3">
          {printToolbarStage < 2 ? (
            <>
              <PrintHeaderModeMenu headerMode={headerMode} onHeaderModeChange={setHeaderMode} />
              <PrintCompactLayoutControl
                compactLayout={compactLayout}
                canEdit={canEditTextLayout}
                ready={printPreviewReady}
                label={printToolbarStage === 0 ? "紧凑排版" : "紧凑"}
                onToggle={handleTextLayoutModeToggle}
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
              compactLayout={compactLayout}
              canEditTextLayout={canEditTextLayout}
              printPreviewReady={printPreviewReady}
              headerMode={headerMode}
              previewScale={previewScale}
              previewScaleFitWidth={previewScaleFitWidth}
              previewScaleFitPage={previewScaleFitPage}
              onTextLayoutModeToggle={handleTextLayoutModeToggle}
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
              compactLayout={compactLayout}
              canEditTextLayout={canEditTextLayout}
              printPreviewReady={printPreviewReady}
              headerMode={headerMode}
              previewScale={previewScale}
              previewScaleFitWidth={previewScaleFitWidth}
              previewScaleFitPage={previewScaleFitPage}
              onTextLayoutModeToggle={handleTextLayoutModeToggle}
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
        <PrintMeasurementLayer
          blocks={blocks}
          characters={characters}
          scenes={scenes}
          contentW={contentW}
          compactLayout={compactLayout}
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
            const continuesToHiddenCharacter = new Set<string>();
            const endsHiddenCharacterRun = new Set<string>();
            let nextBlockHidden = false;
            let hasNextBlock = false;
            for (let i = page.items.length - 1; i >= 0; i--) {
              const item = page.items[i];
              if (item.kind !== "block") continue;
              if (!item.hideChar && hasNextBlock && nextBlockHidden) continuesToHiddenCharacter.add(item.block.id);
              if (item.hideChar && (!hasNextBlock || !nextBlockHidden)) endsHiddenCharacterRun.add(item.block.id);
              nextBlockHidden = item.hideChar;
              hasNextBlock = true;
            }
            return (
              <PrintPage
                key={idx}
                cfg={cfg}
                header={page.sceneLabel}
                headerAlign={getHeaderAlign(page.pageNum)}
                pageNum={page.pageNum}
                watermarkTile={watermarkTile}
              >
                {page.items.map((item, iIdx) =>
                  item.kind === "sceneHeader"
                    ? renderSceneHeader(item.scene, `sh-${item.scene.id}-${iIdx}`)
                    : renderBlock(
                        item.block,
                        item.hideChar,
                        item.leadingCharacterGap,
                        continuesToHiddenCharacter.has(item.block.id),
                        endsHiddenCharacterRun.has(item.block.id),
                        false,
                      )
                )}
              </PrintPage>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
