"use client";
import { useEffect, useRef } from "react";
import { PRESENCE_HEARTBEAT_MS } from "@/lib/presence-heartbeat";
import { useDocumentVisible } from "./useVisibleEventSource";

/**
 * usePresenceHeartbeat — 在场心跳（#578）。
 *
 * 页面可见期间每 PRESENCE_HEARTBEAT_MS 调一次 `send`，让服务端在场表的 `updatedAt`
 * 跟上；隐藏即停（与 useVisibleEventSource 同一道门：后台标签的连接已断、本端已出场，
 * 心跳再把它写回去就是幽灵）。切回标签页时立刻补一拍——隐藏期间条目可能已过期，
 * 等下一拍最多要再等一个间隔。首次挂载不补：各消费方自己有首次上报（cue 的选区
 * effect、wiki 的建连即入场、script 的聚焦块）。
 *
 * `send` 经 ref 取最新闭包，effect 只依赖可见性与 enabled；由 `send` 自己决定
 * 「没什么可重发」（比如 script 还没聚焦过块）就直接返回。
 */
export function usePresenceHeartbeat(send: () => void, enabled = true): void {
  const visible = useDocumentVisible();
  const sendRef = useRef(send);
  sendRef.current = send;
  const armedBeforeRef = useRef(false);

  useEffect(() => {
    if (!enabled || !visible) return;
    if (armedBeforeRef.current) sendRef.current();
    armedBeforeRef.current = true;
    const timer = setInterval(() => sendRef.current(), PRESENCE_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [enabled, visible]);
}
