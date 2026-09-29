"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const MIN_RECORDING_MS = 300;
const CANCEL_DRAG_PX = 56;
const MIME_CANDIDATES = ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus"] as const;

type Phase = "idle" | "requesting" | "recording" | "processing";

function extensionFor(mimeType: string): string {
  const base = mimeType.toLowerCase().split(";", 1)[0];
  if (base.endsWith("/mp4")) return "m4a";
  if (base.endsWith("/ogg")) return "ogg";
  if (base.endsWith("/wav")) return "wav";
  return "webm";
}

function captureErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "无法访问麦克风，请在浏览器设置中允许麦克风权限";
  if (name === "NotFoundError") return "没有找到可用的麦克风";
  if (name === "NotReadableError" || name === "AbortError") return "麦克风正被其他应用占用，请稍后重试";
  return "无法开始录音，请检查浏览器和麦克风设置";
}

export function pickVoiceMimeType(
  recorder: Pick<typeof MediaRecorder, "isTypeSupported"> | undefined,
): string | undefined {
  if (!recorder) return undefined;
  return MIME_CANDIDATES.find((mimeType) => recorder.isTypeSupported(mimeType));
}

export function voiceFileName(mimeType: string, now = Date.now()): string {
  return `voice-${new Date(now).toISOString().replace(/[:.]/g, "-")}.${extensionFor(mimeType)}`;
}

export function isVoiceCancelGesture(startY: number, currentY: number): boolean {
  return startY - currentY >= CANCEL_DRAG_PX;
}

export default function VoiceRecordButton({
  disabled,
  cancelKey,
  onRecorded,
  onError,
}: {
  disabled: boolean;
  /** 面板关闭或会话切换时改变；正在授权/录音的内容必须丢弃并释放麦克风。 */
  cancelKey: string;
  onRecorded: (file: File) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [cancelArmed, setCancelArmed] = useState(false);
  const cancelArmedRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const heldRef = useRef(false);
  const cancelledRef = useRef(false);
  const generationRef = useRef(0);
  const startedAtRef = useRef(0);
  const pointerStartYRef = useRef<number | null>(null);
  const onRecordedRef = useRef(onRecorded);
  const onErrorRef = useRef(onError);
  const disabledRef = useRef(disabled);
  onRecordedRef.current = onRecorded;
  onErrorRef.current = onError;
  disabledRef.current = disabled;

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const cancelCapture = useCallback(() => {
    heldRef.current = false;
    cancelledRef.current = true;
    generationRef.current += 1;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* 已被浏览器中断 */ }
    }
    releaseStream();
    chunksRef.current = [];
    pointerStartYRef.current = null;
    cancelArmedRef.current = false;
    setCancelArmed(false);
    setPhase("idle");
  }, [releaseStream]);

  useEffect(() => cancelCapture(), [cancelCapture, cancelKey]);
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === "hidden") cancelCapture(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      cancelCapture();
    };
  }, [cancelCapture]);

  const beginCapture = useCallback(async () => {
    if (disabledRef.current || phase !== "idle") return;
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      onErrorRef.current("当前浏览器不支持录音");
      return;
    }
    heldRef.current = true;
    cancelledRef.current = false;
    cancelArmedRef.current = false;
    setCancelArmed(false);
    const generation = ++generationRef.current;
    setPhase("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!heldRef.current || cancelledRef.current || generation !== generationRef.current || disabledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        setPhase("idle");
        return;
      }
      streamRef.current = stream;
      const requestedMime = pickVoiceMimeType(MediaRecorder);
      const recorder = requestedMime ? new MediaRecorder(stream, { mimeType: requestedMime }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onerror = () => {
        onErrorRef.current("录音被浏览器中断，请重试");
        cancelCapture();
      };
      recorder.onstop = () => {
        recorderRef.current = null;
        releaseStream();
        const chunks = chunksRef.current;
        chunksRef.current = [];
        const heldMs = Date.now() - startedAtRef.current;
        if (cancelledRef.current || generation !== generationRef.current || heldMs < MIN_RECORDING_MS || chunks.length === 0) {
          setCancelArmed(false);
          setPhase("idle");
          return;
        }
        const mimeType = recorder.mimeType || requestedMime || chunks[0]?.type || "audio/webm";
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size === 0) { setPhase("idle"); return; }
        const file = new File([blob], voiceFileName(mimeType), { type: mimeType, lastModified: Date.now() });
        setCancelArmed(false);
        setPhase("processing");
        void onRecordedRef.current(file)
          .catch((error) => onErrorRef.current(error instanceof Error ? error.message : "语音发送失败"))
          .finally(() => { if (generation === generationRef.current) setPhase("idle"); });
      };
      recorder.start(1000);
      setPhase("recording");
    } catch (error) {
      releaseStream();
      if (generation === generationRef.current) setPhase("idle");
      if (!cancelledRef.current) onErrorRef.current(captureErrorMessage(error));
    }
  }, [cancelCapture, phase, releaseStream]);

  const endCapture = useCallback(() => {
    heldRef.current = false;
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    try { recorder.stop(); } catch { cancelCapture(); }
  }, [cancelCapture]);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerStartYRef.current = event.clientY;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    void beginCapture();
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!heldRef.current || pointerStartYRef.current === null) return;
    const nextCancelArmed = isVoiceCancelGesture(pointerStartYRef.current, event.clientY);
    cancelArmedRef.current = nextCancelArmed;
    setCancelArmed(nextCancelArmed);
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    pointerStartYRef.current = null;
    if (cancelArmedRef.current) cancelCapture();
    else endCapture();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault(); void beginCapture(); }
  };
  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key === "Enter") { event.preventDefault(); endCapture(); }
  };

  const label = cancelArmed
    ? "松开取消录音"
    : phase === "requesting"
    ? "正在请求麦克风…"
    : phase === "recording" ? "松开发送语音，上滑取消" : phase === "processing" ? "正在发送语音…" : "按住说话";

  return (
    <div className="relative shrink-0 sm:hidden">
      {(phase === "recording" || phase === "requesting") && (
        <div className={`pointer-events-none absolute bottom-[46px] left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium shadow-md ${
          cancelArmed ? "bg-red-600 text-white" : "bg-zinc-800 text-white"
        }`}>
          {cancelArmed ? "松开取消" : "↑ 上滑取消"}
        </div>
      )}
      <button
        type="button"
        aria-label={label}
        aria-pressed={phase === "recording"}
        title={label}
        disabled={disabled || phase === "processing"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelCapture}
        onBlur={() => { if (heldRef.current) cancelCapture(); }}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onContextMenu={(event) => event.preventDefault()}
        className={`grid h-[38px] touch-none select-none place-items-center rounded-lg border px-2 text-sm ${
          cancelArmed
            ? "min-w-[112px] border-red-500 bg-red-600 text-white"
            : phase === "recording"
              ? "min-w-[112px] animate-pulse border-red-400 bg-red-50 text-red-700"
              : "w-[38px] border-zinc-300 text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"
        }`}
      >
        {cancelArmed ? "松开取消" : phase === "recording" ? "松开发送" : phase === "requesting" ? "…" : phase === "processing" ? "↥" : "🎤"}
      </button>
    </div>
  );
}
