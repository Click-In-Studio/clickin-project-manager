"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type ScriptRecoveryStatus = "ready" | "reconnecting" | "failed";

/** 恢复期间串行处理保存与加载；重复信号只要求再读取，不并发重载。 */
export function useScriptRecovery(callbacks: {
  pause: () => void;
  reconcile: () => Promise<void>;
}) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const [status, setStatus] = useState<ScriptRecoveryStatus>("ready");
  const suspendedRef = useRef(false);
  const mountedRef = useRef(true);
  const runningRef = useRef<Promise<void> | null>(null);
  const requestedRef = useRef(0);
  const connectedRef = useRef(true);

  const suspend = useCallback(() => {
    connectedRef.current = false;
    suspendedRef.current = true;
    callbacksRef.current.pause();
    if (mountedRef.current) setStatus("reconnecting");
  }, []);
  const recover = useCallback(() => {
    suspend();
    connectedRef.current = true;
    requestedRef.current++;
    if (runningRef.current) return runningRef.current;
    const run = async () => {
      try {
        let request: number;
        do {
          request = requestedRef.current;
          await callbacksRef.current.reconcile();
          if (!mountedRef.current || !connectedRef.current) return;
        } while (request !== requestedRef.current);
        suspendedRef.current = false;
        setStatus("ready");
      } catch {
        if (mountedRef.current && connectedRef.current) setStatus("failed");
      } finally {
        runningRef.current = null;
      }
    };
    // 让 runningRef 先就位，避免 reconcile 同步触发另一次恢复。
    runningRef.current = Promise.resolve().then(run);
    return runningRef.current;
  }, [suspend]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  return { status, suspendedRef, suspend, recover };
}
