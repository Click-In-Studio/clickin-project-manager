import { useLayoutEffect, useState } from "react";
import { SPEECH_TAIL_PIN_OFFSET_PX, SPEECH_TAIL_BASE_HALF_PX, SPEECH_TAIL_EDGE_INSET_PX, SIDE_PANEL_TOP_PX } from "./constants";
import { getScrollEl } from "./dom-scroll";

export function useBlockSpeechTail(blockId: string) {
  const [pointerTop, setPointerTop] = useState(SPEECH_TAIL_EDGE_INSET_PX);
  const [pointerOffsetY, setPointerOffsetY] = useState(0);

  useLayoutEffect(() => {
    const updatePointer = () => {
      const panelHeight = window.innerHeight - SIDE_PANEL_TOP_PX;
      const blockEl = document.getElementById(`block-${blockId}`);
      if (!blockEl) {
        setPointerTop(SPEECH_TAIL_EDGE_INSET_PX);
        setPointerOffsetY(0);
        return;
      }
      const rect = blockEl.getBoundingClientRect();
      const raw = rect.top + rect.height / 2 - SIDE_PANEL_TOP_PX;
      const minPointerTop = SPEECH_TAIL_EDGE_INSET_PX;
      const maxPointerTop = Math.max(minPointerTop, panelHeight - minPointerTop);
      if (raw - SPEECH_TAIL_BASE_HALF_PX <= minPointerTop) {
        setPointerTop(minPointerTop);
        setPointerOffsetY(SPEECH_TAIL_PIN_OFFSET_PX);
        return;
      }
      if (raw + SPEECH_TAIL_BASE_HALF_PX >= maxPointerTop) {
        setPointerTop(maxPointerTop);
        setPointerOffsetY(-SPEECH_TAIL_PIN_OFFSET_PX);
        return;
      }
      setPointerTop(raw);
      setPointerOffsetY(0);
    };
    updatePointer();
    window.addEventListener("resize", updatePointer);
    const tailScrollEl = getScrollEl();
    tailScrollEl.addEventListener("scroll", updatePointer, { passive: true });
    return () => {
      window.removeEventListener("resize", updatePointer);
      tailScrollEl.removeEventListener("scroll", updatePointer);
    };
  }, [blockId]);

  return { pointerTop, pointerOffsetY };
}
