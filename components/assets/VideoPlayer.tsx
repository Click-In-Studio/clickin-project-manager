"use client";

import { useRef, useState, useEffect, useCallback } from "react";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return "--:--";
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
}

interface Props {
  url: string;
  fileName: string;
}

export default function VideoPlayer({ url, fileName }: Props) {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const speedValRef = useRef(1);       // always reflects latest speed without stale closure
  const isScrubbing = useRef(false);  // suppress timeupdate while user drags seek bar
  const justClosedSpeed = useRef(false); // prevent video click from firing after closing dropdown

  const [playing,     setPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(0);
  const [muted,       setMuted]       = useState(false);
  const [speed,       setSpeed]       = useState(1);
  const [speedOpen,   setSpeedOpen]   = useState(false);

  // ── Video event listeners ─────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay    = () => setPlaying(true);
    const onPause   = () => setPlaying(false);
    const onEnded   = () => setPlaying(false);
    const onTime    = () => { if (!isScrubbing.current) setCurrentTime(v.currentTime); };
    const onMeta    = () => setDuration(isFinite(v.duration) ? v.duration : 0);
    const onVol     = () => setMuted(v.muted);
    const onCanPlay = () => { v.playbackRate = speedValRef.current; };

    v.addEventListener("play",           onPlay);
    v.addEventListener("pause",          onPause);
    v.addEventListener("ended",          onEnded);
    v.addEventListener("timeupdate",     onTime);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("durationchange", onMeta);
    v.addEventListener("volumechange",   onVol);
    v.addEventListener("canplay",        onCanPlay);
    return () => {
      v.removeEventListener("play",           onPlay);
      v.removeEventListener("pause",          onPause);
      v.removeEventListener("ended",          onEnded);
      v.removeEventListener("timeupdate",     onTime);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("durationchange", onMeta);
      v.removeEventListener("volumechange",   onVol);
      v.removeEventListener("canplay",        onCanPlay);
    };
  }, [url]);

  // ── Playback controls ─────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (v) v.muted = !v.muted;
  }, []);

  const requestFullscreen = useCallback(() => {
    videoRef.current?.requestFullscreen?.();
  }, []);

  // Clicking the video area toggles play — but skip if we just closed the speed dropdown
  const handleVideoClick = useCallback(() => {
    if (justClosedSpeed.current) { justClosedSpeed.current = false; return; }
    togglePlay();
  }, [togglePlay]);

  // ── Speed ─────────────────────────────────────────────────────────────────
  const applySpeed = useCallback((rate: number) => {
    speedValRef.current = rate;
    setSpeed(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
    setSpeedOpen(false);
  }, []);

  // ── Keyboard shortcuts (physical key codes — immune to IME) ──────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); return; }
      const faster = e.shiftKey && e.code === "Period"; // Shift+.
      const slower = e.shiftKey && e.code === "Comma";  // Shift+,
      if (!faster && !slower) return;
      const idx  = SPEEDS.indexOf(speedValRef.current);
      const next = faster
        ? (idx < SPEEDS.length - 1 ? SPEEDS[idx + 1] : speedValRef.current)
        : (idx > 0                  ? SPEEDS[idx - 1] : speedValRef.current);
      if (next !== speedValRef.current) {
        speedValRef.current = next;
        setSpeed(next);
        if (videoRef.current) videoRef.current.playbackRate = next;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  // ── Close dropdown on outside click ──────────────────────────────────────
  useEffect(() => {
    if (!speedOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        justClosedSpeed.current = true; // suppress next handleVideoClick
        setSpeedOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [speedOpen]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col" style={{ maxWidth: "min(900px, 100%)", width: "100%" }}>

      {/* Video area — click to play/pause */}
      <div
        className="relative cursor-pointer select-none bg-black rounded-t-lg overflow-hidden"
        onClick={handleVideoClick}
      >
        <video
          ref={videoRef}
          src={url}
          className="w-full block outline-none"
          style={{ maxHeight: "calc(100vh - 120px)" }}
          tabIndex={-1}     /* no keyboard focus → no browser media key interception */
          preload="metadata"
        />
        {/* Paused overlay */}
        {!playing && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-14 h-14 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="white" style={{ marginLeft: 3 }}>
                <path d="M8 5v14l11-7z"/>
              </svg>
            </div>
          </div>
        )}
      </div>

      {/* Controls bar */}
      <div className="rounded-b-lg bg-zinc-900 px-3 py-2 flex items-center gap-2">

        {/* Play / Pause */}
        <button
          onClick={togglePlay}
          className="shrink-0 w-7 h-7 flex items-center justify-center text-white/60 hover:text-white transition-colors"
          aria-label={playing ? "暂停" : "播放"}
        >
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="2" width="4" height="12" rx="1"/>
              <rect x="9" y="2" width="4" height="12" rx="1"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2.5l10 5.5-10 5.5V2.5z"/>
            </svg>
          )}
        </button>

        {/* Current time */}
        <span className="shrink-0 text-[11px] font-mono text-white/40 tabular-nums w-9 text-right">
          {formatTime(currentTime)}
        </span>

        {/* Seek bar — isScrubbing suppresses timeupdate feedback during drag */}
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onMouseDown={() => { isScrubbing.current = true; }}
          onMouseUp={e => {
            isScrubbing.current = false;
            const t = Number((e.target as HTMLInputElement).value);
            if (videoRef.current) videoRef.current.currentTime = t;
          }}
          onChange={e => setCurrentTime(Number(e.target.value))}
          className="flex-1 accent-white cursor-pointer"
          style={{ height: 4 }}
        />

        {/* Duration */}
        <span className="shrink-0 text-[11px] font-mono text-white/40 tabular-nums w-9">
          {formatTime(duration)}
        </span>

        {/* Mute */}
        <button
          onClick={toggleMute}
          className="shrink-0 text-white/40 hover:text-white/80 transition-colors"
          aria-label={muted ? "取消静音" : "静音"}
        >
          {muted ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M11 5L6 9H2v6h4l5 4V5z"/>
              <line x1="23" y1="9" x2="17" y2="15"/>
              <line x1="17" y1="9" x2="23" y2="15"/>
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M11 5L6 9H2v6h4l5 4V5z"/>
              <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>
            </svg>
          )}
        </button>

        {/* Fullscreen */}
        <button
          onClick={requestFullscreen}
          className="shrink-0 text-white/40 hover:text-white/80 transition-colors"
          aria-label="全屏"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>
          </svg>
        </button>

        {/* Speed badge + dropdown */}
        <div ref={dropdownRef} className="relative shrink-0">
          <button
            onClick={() => setSpeedOpen(o => !o)}
            className="min-w-[28px] text-right text-xs font-mono text-white/40 transition-colors hover:text-white/80"
          >
            {speed}×
          </button>
          {speedOpen && (
            <div className="absolute bottom-full z-10 mb-2 right-0 min-w-[72px] overflow-hidden rounded-xl border border-white/10 bg-zinc-800 shadow-2xl">
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
    </div>
  );
}
