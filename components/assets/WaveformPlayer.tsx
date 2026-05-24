"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface Props {
  url: string;
  fileName: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function WaveformPlayer({ url, fileName }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<import("wavesurfer.js").default | null>(null);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    let ws: import("wavesurfer.js").default;
    let destroyed = false;

    import("wavesurfer.js").then(({ default: WaveSurfer }) => {
      if (destroyed || !containerRef.current) return;

      ws = WaveSurfer.create({
        container: containerRef.current,
        waveColor: "rgba(255,255,255,0.2)",
        progressColor: "rgba(255,255,255,0.85)",
        cursorColor: "rgba(255,255,255,0.6)",
        cursorWidth: 2,
        height: 80,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        normalize: true,
        interact: true,
        url,
        fetchParams: { credentials: "omit" },
      });

      wsRef.current = ws;

      ws.on("ready", (d) => {
        if (destroyed) return;
        setDuration(d);
        setReady(true);
      });
      ws.on("timeupdate", (t) => { if (!destroyed) setCurrentTime(t); });
      ws.on("play",   () => { if (!destroyed) setPlaying(true); });
      ws.on("pause",  () => { if (!destroyed) setPlaying(false); });
      ws.on("finish", () => { if (!destroyed) setPlaying(false); });
      ws.on("error",  () => { if (!destroyed) setError(true); });
    });

    return () => {
      destroyed = true;
      ws?.destroy();
      wsRef.current = null;
    };
  }, [url]);

  const togglePlay = useCallback(() => {
    wsRef.current?.playPause();
  }, []);

  const skip = useCallback((delta: number) => {
    const ws = wsRef.current;
    if (!ws) return;
    ws.setTime(Math.max(0, Math.min(duration, ws.getCurrentTime() + delta)));
  }, [duration]);

  return (
    <div className="w-full max-w-2xl rounded-2xl bg-zinc-900 px-6 py-8 shadow-2xl">
      {/* File name */}
      <p className="text-xs text-white/40 truncate mb-6 text-center">{fileName}</p>

      {/* Waveform */}
      <div className="relative mb-5">
        {/* Loading skeleton */}
        {!ready && !error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex items-end gap-0.5 h-12">
              {Array.from({ length: 40 }).map((_, i) => (
                <div
                  key={i}
                  className="w-1 rounded-full bg-white/10 animate-pulse"
                  style={{
                    height: `${20 + Math.random() * 60}%`,
                    animationDelay: `${i * 30}ms`,
                  }}
                />
              ))}
            </div>
          </div>
        )}
        {error && (
          <div className="h-20 flex items-center justify-center">
            <p className="text-xs text-white/30">波形加载失败，仍可播放</p>
          </div>
        )}
        <div
          ref={containerRef}
          className={!ready && !error ? "opacity-0" : "opacity-100"}
          style={{ transition: "opacity 0.3s" }}
        />
      </div>

      {/* Time display */}
      <div className="flex justify-between text-[11px] font-mono text-white/30 mb-4 px-0.5">
        <span>{formatTime(currentTime)}</span>
        <span>{duration > 0 ? formatTime(duration) : "--:--"}</span>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-6">
        {/* Rewind 10s */}
        <button
          onClick={() => skip(-10)}
          disabled={!ready}
          className="text-white/40 hover:text-white/80 disabled:opacity-20 transition-colors text-sm"
          title="-10s"
        >
          ↺ 10
        </button>

        {/* Play / Pause */}
        <button
          onClick={togglePlay}
          disabled={!ready && !error}
          className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-20 flex items-center justify-center text-white transition-colors"
          aria-label={playing ? "暂停" : "播放"}
        >
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="2" width="4" height="12" rx="1"/>
              <rect x="9" y="2" width="4" height="12" rx="1"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2.5l10 5.5-10 5.5V2.5z"/>
            </svg>
          )}
        </button>

        {/* Forward 10s */}
        <button
          onClick={() => skip(10)}
          disabled={!ready}
          className="text-white/40 hover:text-white/80 disabled:opacity-20 transition-colors text-sm"
          title="+10s"
        >
          ↻ 10
        </button>
      </div>
    </div>
  );
}
