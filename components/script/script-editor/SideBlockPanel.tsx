"use client";

import React, { useLayoutEffect, useRef, useState } from "react";
import ChevronIcon from "@/components/ui/ChevronIcon";
import SpeechTail from "./SpeechTail";
import type { CommentBlockCaption, SideBlockPanelNavigation, BlockSidePanelKind } from "./comments";
import { SPEECH_TAIL_BASE_HALF_PX, SIDE_PANEL_TOP_PX } from "./constants";
import { useBlockSpeechTail } from "./use-block-speech-tail";

export default function SideBlockPanel({
  blockId,
  activePanel,
  onPanelChange,
  blockCaption,
  width,
  navigation,
  onClose,
  children,
}: {
  blockId: string;
  activePanel: BlockSidePanelKind;
  onPanelChange: (panel: BlockSidePanelKind) => void;
  blockCaption?: CommentBlockCaption | null;
  width: number;
  navigation?: SideBlockPanelNavigation;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { pointerTop, pointerOffsetY } = useBlockSpeechTail(blockId);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);

  useLayoutEffect(() => {
    const updateHeaderHeight = () => setHeaderHeight(headerRef.current?.offsetHeight ?? 0);
    updateHeaderHeight();
    window.addEventListener("resize", updateHeaderHeight);
    return () => window.removeEventListener("resize", updateHeaderHeight);
  }, [activePanel, blockCaption?.label, blockCaption?.body]);

  const tailUsesHeaderFill = pointerTop + SPEECH_TAIL_BASE_HALF_PX <= headerHeight;

  return (
    <div
      className="fixed right-0 bottom-0 isolate z-30 flex flex-col border-l border-[var(--line)] bg-[var(--surface)] shadow-xl panel-mobile-full"
      style={{
        top: SIDE_PANEL_TOP_PX,
        width,
      }}
    >
      <SpeechTail top={pointerTop} offsetY={pointerOffsetY} fillClassName={tailUsesHeaderFill ? "fill-zinc-100" : "fill-white"} />
      <div ref={headerRef} className="relative z-10 shrink-0 border-y border-emerald-600/80 bg-zinc-100 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <button
              type="button"
              onClick={() => onPanelChange("comment")}
              aria-pressed={activePanel === "comment"}
              className={activePanel === "comment" ? "text-zinc-700" : "text-zinc-300 hover:text-emerald-600/80"}
            >
              评论
            </button>
            <span className="text-zinc-300" aria-hidden="true">/</span>
            <button
              type="button"
              onClick={() => onPanelChange("asset")}
              aria-pressed={activePanel === "asset"}
              className={activePanel === "asset" ? "text-zinc-700" : "text-zinc-300 hover:text-emerald-600/80"}
            >
              附件
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {navigation && (
              <>
                <button
                  type="button"
                  onClick={navigation.onPrevious}
                  disabled={!navigation.hasPrevious}
                  className="inline-flex h-5 w-5 items-center justify-center text-zinc-800 hover:text-emerald-600/80 disabled:cursor-default disabled:opacity-25 disabled:hover:text-zinc-800"
                  title="上一条"
                >
                  <ChevronIcon direction="up" />
                </button>
                <button
                  type="button"
                  onClick={navigation.onNext}
                  disabled={!navigation.hasNext}
                  className="inline-flex h-5 w-5 items-center justify-center text-zinc-800 hover:text-emerald-600/80 disabled:cursor-default disabled:opacity-25 disabled:hover:text-zinc-800"
                  title="下一条"
                >
                  <ChevronIcon />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-5 w-5 items-center justify-center text-zinc-800 hover:text-emerald-600/80"
              title="关闭"
            >
              <span className="relative h-3 w-3" aria-hidden="true">
                <span className="absolute left-1/2 top-1/2 h-0.5 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current" />
                <span className="absolute left-1/2 top-1/2 h-0.5 w-3 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current" />
              </span>
            </button>
          </div>
        </div>
        {blockCaption && (
          <p className="mt-2 line-clamp-1 text-xs leading-snug text-zinc-500" title={`${blockCaption.label} ${blockCaption.body}`}>
            <span className="font-bold text-zinc-700">{blockCaption.label}</span>{" "}
            <span>{blockCaption.body}</span>
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
