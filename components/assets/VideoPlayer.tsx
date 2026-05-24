"use client";

import { useRef, useState, useEffect, useCallback } from "react";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

interface Props {
  url: string;
  fileName: string;
}

export default function VideoPlayer({ url, fileName }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Keep a ref so keyboard handler always sees the latest speed without stale closure
  const speedValRef = useRef(1);

  const [speed, setSpeed] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);

  const applySpeed = useCallback((rate: number) => {
    speedValRef.current = rate;
    setSpeed(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
    setSpeedOpen(false);
  }, []);

  // Re-apply speed when the browser resets playbackRate after src load
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onCanPlay = () => { video.playbackRate = speedValRef.current; };
    video.addEventListener("canplay", onCanPlay);
    return () => video.removeEventListener("canplay", onCanPlay);
  }, [url]);

  // Keyboard shortcuts: < slow down, > speed up
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return; // IME 输入中，忽略
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      }
      // 用 e.code 判断物理键位，避免中文输入法将 Shift+. / Shift+, 转为《》
      const faster = e.shiftKey && e.code === "Period";   // Shift+.  → >
      const slower = e.shiftKey && e.code === "Comma";    // Shift+,  → <
      if (faster) {
        const idx = SPEEDS.indexOf(speedValRef.current);
        const next = idx < SPEEDS.length - 1 ? SPEEDS[idx + 1] : speedValRef.current;
        if (next !== speedValRef.current) {
          speedValRef.current = next;
          setSpeed(next);
          if (videoRef.current) videoRef.current.playbackRate = next;
        }
      } else if (slower) {
        const idx = SPEEDS.indexOf(speedValRef.current);
        const next = idx > 0 ? SPEEDS[idx - 1] : speedValRef.current;
        if (next !== speedValRef.current) {
          speedValRef.current = next;
          setSpeed(next);
          if (videoRef.current) videoRef.current.playbackRate = next;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!speedOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setSpeedOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [speedOpen]);

  return (
    <div className="relative inline-block max-w-full">
      <video
        ref={videoRef}
        src={url}
        controls
        className="max-w-full rounded-lg shadow-2xl outline-none block"
        style={{ maxHeight: "calc(100vh - 80px)", maxWidth: "100%" }}
      />

      {/* Speed badge — top-right overlay */}
      <div ref={dropdownRef} className="absolute top-3 right-3">
        <button
          onClick={() => setSpeedOpen(o => !o)}
          className="rounded bg-black/50 px-2 py-0.5 text-xs font-mono text-white/60 backdrop-blur-sm transition-colors hover:text-white"
        >
          {speed}×
        </button>

        {speedOpen && (
          <div className="absolute right-0 top-full z-10 mt-1 min-w-[72px] overflow-hidden rounded-xl border border-white/10 bg-zinc-800 shadow-2xl">
            {SPEEDS.map(r => (
              <button
                key={r}
                onClick={() => applySpeed(r)}
                className={`w-full px-4 py-1.5 text-left text-xs font-mono transition-colors ${
                  r === speed
                    ? "bg-white/15 text-white"
                    : "text-white/50 hover:bg-white/5 hover:text-white/80"
                }`}
              >
                {r}×
              </button>
            ))}
            <div className="border-t border-white/10 px-3 py-1.5 text-center font-mono text-[10px] text-white/25">
              {"< 减速  > 加速"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
