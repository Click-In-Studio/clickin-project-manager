"use client";

import React from "react";
import { LINE_INDEX_GUTTER_OFFSET_REM } from "./constants";

export default function InsertZone({ lineIndexWidth, onInsert }: { lineIndexWidth?: string; onInsert: () => void }) {
  const style: React.CSSProperties | undefined = lineIndexWidth
    ? { paddingLeft: `calc(${lineIndexWidth} + ${LINE_INDEX_GUTTER_OFFSET_REM}rem)` }
    : undefined;
  return (
    <div className="group flex h-5 items-center justify-center px-6" style={style}>
      <button
        onClick={onInsert}
        title="插入新块"
        className="flex h-5 w-5 items-center justify-center rounded-full text-[12px] leading-none text-zinc-300 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-zinc-500 group-hover:opacity-100"
      >
        +
      </button>
    </div>
  );
}
