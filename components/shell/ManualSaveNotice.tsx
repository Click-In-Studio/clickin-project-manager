"use client";

import { useEffect, useRef, useState } from "react";

const MANUAL_SAVE_NOTICE = "编辑内容会自动上传、实时同步，无需手动保存。";

export default function ManualSaveNotice() {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const show = () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setVisible(true);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setVisible(false);
      }, 1800);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return;
      if (event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      show();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed left-1/2 top-20 z-50 -translate-x-1/2">
      <div className="rounded bg-zinc-900/80 px-2 py-1 text-[11px] text-white shadow-sm">
        {MANUAL_SAVE_NOTICE}
      </div>
    </div>
  );
}
