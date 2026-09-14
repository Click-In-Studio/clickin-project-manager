"use client";

import { SPEECH_TAIL_PIN_OFFSET_PX, SPEECH_TAIL_BASE_HALF_PX } from "./constants";

export default function SpeechTail({
  offsetY = 0,
  top = "50%",
  fillClassName = "fill-white",
}: {
  offsetY?: number;
  top?: number | string;
  fillClassName?: string;
}) {
  const rawPointOffset = -Math.round(offsetY);
  const width = 24;
  const overlap = 4;
  const baseHalf = SPEECH_TAIL_BASE_HALF_PX;
  const padding = 16;
  const pointSlideLimit = SPEECH_TAIL_PIN_OFFSET_PX;
  const baseSlideLimit = 48;
  const isPinned = Math.abs(offsetY) >= pointSlideLimit;
  const pointOffset = Math.max(-pointSlideLimit, Math.min(pointSlideLimit, rawPointOffset));
  const baseOffset = Math.max(-baseSlideLimit, Math.min(baseSlideLimit, rawPointOffset * 0.65));
  const height = isPinned ? 36 : Math.max(32, (Math.max(Math.abs(pointOffset), Math.abs(baseOffset)) + padding) * 2);
  const centerY = height / 2;
  const pinnedFromTop = offsetY > 0;
  const pointY = isPinned ? (pinnedFromTop ? 2 : height - 2) : centerY + pointOffset;
  const baseY = isPinned ? pointY : centerY + baseOffset;
  const baseTopY = isPinned && pinnedFromTop ? pointY : isPinned ? pointY - baseHalf * 2 : baseY - baseHalf;
  const baseBottomY = isPinned && !pinnedFromTop ? pointY : isPinned ? pointY + baseHalf * 2 : baseY + baseHalf;
  const topValue = typeof top === "number" ? `${top}px` : top;

  return (
    <svg
      className="pointer-events-none absolute left-0 z-[5] overflow-visible"
      style={{
        top: topValue,
        width,
        height,
        transform: `translate(${-width + overlap}px, ${-height / 2}px)`,
      }}
      aria-hidden="true"
    >
      <polygon
        className={fillClassName}
        points={`0,${pointY} ${width},${baseTopY} ${width},${baseBottomY}`}
        stroke="#e4e4e7"
        strokeWidth="1"
      />
    </svg>
  );
}
