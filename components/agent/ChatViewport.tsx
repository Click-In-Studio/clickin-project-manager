"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Bubble } from "@/lib/agent/chat/stream-reducer";

type Item = Bubble & { key?: string };
export type ChatViewportHandle = { reveal: (key: string) => void; follow: () => void };
const GAP = 12;
const BUFFER = 500;

/** 只挂载视窗附近的重内容；交互过的卡片与播放中的媒体保留组件状态。 */
export default forwardRef<ChatViewportHandle, {
  items: Item[];
  sessionKey: string | null;
  renderItem: (item: Item, index: number) => ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
}>(function ChatViewport({ items, sessionKey, renderItem, header, footer }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const retained = useRef(new Set<string>());
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const following = useRef(true);
  const previousTop = useRef(0);
  const touchY = useRef(0);
  const target = useRef<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState({ top: 0, height: 600, following: true });
  const itemKey = (item: Item) => item.key!;
  const layout = useMemo(() => {
    const offsets: number[] = [];
    let total = 0;
    for (const item of items) {
      offsets.push(total);
      total += (heights.current.get(item.key!) ?? (item.kind === "assistant" ? 280 : 70)) + GAP;
    }
    return { offsets, total };
    // 尺寸回调修改缓存后通过 revision 重建累计高度。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, revision]);

  const listTop = useCallback(() => {
    const container = scrollRef.current, list = listRef.current;
    return container && list ? list.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop : 0;
  }, []);
  const captureAnchor = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top;
    const rows = [...container.querySelectorAll<HTMLElement>("[data-chat-row]")];
    const row = rows.find(el => el.getBoundingClientRect().bottom > top);
    if (row) anchor.current = { key: row.dataset.chatRow!, offset: row.getBoundingClientRect().top - top };
  }, []);
  const updateView = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const next = { top: Math.max(0, container.scrollTop - listTop()), height: container.clientHeight || 600, following: following.current };
    setView(prev => prev.top === next.top && prev.height === next.height && prev.following === next.following ? prev : next);
  }, [listTop]);
  const takeControl = useCallback(() => {
    following.current = false;
    target.current = null;
    captureAnchor();
    updateView();
  }, [captureAnchor, updateView]);
  const follow = useCallback(() => {
    following.current = true;
    target.current = null;
    updateView();
    setRevision(value => value + 1);
  }, [updateView]);
  useImperativeHandle(ref, () => ({
    follow,
    reveal(key) {
      following.current = false;
      target.current = key;
      const index = items.findIndex(item => item.key === key);
      if (index < 0) return;
      const top = layout.offsets[index];
      if (scrollRef.current) scrollRef.current.scrollTop = top + listTop();
      setView(prev => ({ ...prev, top, following: false }));
    },
  }), [follow, items, layout, listTop]);

  useLayoutEffect(() => {
    heights.current.clear();
    retained.current.clear();
    anchor.current = null;
    target.current = null;
    following.current = true;
    setView({ top: 0, height: scrollRef.current?.clientHeight || 600, following: true });
    setRevision(value => value + 1);
  }, [sessionKey]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const destination = target.current;
    const row = destination ? [...container.querySelectorAll<HTMLElement>("[data-chat-row]")].find(el => el.dataset.chatRow === destination) : null;
    if (following.current) {
      container.scrollTop = container.scrollHeight;
    } else if (row) {
      container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top;
      row.querySelector<HTMLElement>("[data-question-id]")?.focus({ preventScroll: true });
      target.current = null;
    } else if (anchor.current) {
      const index = items.findIndex(item => item.key === anchor.current!.key);
      if (index >= 0) container.scrollTop = listTop() + layout.offsets[index] - anchor.current.offset;
    }
    previousTop.current = container.scrollTop;
    updateView();
    // 尺寸尚在收敛时不能按临时重叠的 DOM 重选锚点；只有用户滚动才更新它。
    if (following.current || row || !anchor.current) captureAnchor();
  }, [items, layout, view.following, header, footer, listTop, captureAnchor, updateView]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const key = el.dataset.chatRow;
        if (!key) { changed = true; continue; }
        const height = el.getBoundingClientRect().height;
        if (Math.abs((heights.current.get(key) ?? -1) - height) > 0.5) {
          heights.current.set(key, height);
          changed = true;
        }
      }
      if (changed) setRevision(value => value + 1);
    });
    for (const el of [scrollRef.current, contentRef.current, ...scrollRef.current?.querySelectorAll<HTMLElement>("[data-chat-row]") ?? []]) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items, view.top, view.height, view.following]);

  const visibleTop = view.following ? Math.max(0, layout.total - view.height) : view.top;
  return <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4" style={{ overflowAnchor: "none" }}
      onWheel={event => { if (event.deltaY < 0) takeControl(); }}
      onTouchStart={event => { touchY.current = event.touches[0]?.clientY ?? 0; }}
      onTouchMove={event => { if ((event.touches[0]?.clientY ?? 0) > touchY.current) takeControl(); }}
      onPointerDown={event => { if (event.target === event.currentTarget) takeControl(); }}
      onKeyDown={event => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) takeControl(); }}
      onScroll={() => {
        const container = scrollRef.current!;
        if (Math.abs(container.scrollTop - previousTop.current) > 1) {
          const atBottom = container.scrollHeight - container.clientHeight - container.scrollTop < 24;
          if (atBottom) following.current = true;
          else if (container.scrollTop < previousTop.current) following.current = false;
          captureAnchor();
        }
        previousTop.current = container.scrollTop;
        updateView();
      }}>
      <div ref={contentRef}>
        {header}
        <div ref={listRef} className="relative" style={{ height: layout.total }}>
          {items.map((item, index) => {
            const key = itemKey(item), top = layout.offsets[index];
            const height = heights.current.get(key) ?? (item.kind === "assistant" ? 280 : 70);
            const visible = top + height >= visibleTop - BUFFER && top <= visibleTop + view.height + BUFFER;
            const pendingCard = (item.kind === "question" && !item.status && item.question.status === "pending") ||
              (item.kind === "approval" && !item.decision);
            const settledCard = (item.kind === "question" && !pendingCard) || (item.kind === "approval" && !pendingCard);
            if (!visible && !pendingCard && (settledCard || !retained.current.has(key))) return null;
            return <div key={key} data-chat-row={key} className="absolute inset-x-0" style={{ top }}
              onClickCapture={event => {
                if ((event.target as HTMLElement).closest("button,summary,input,textarea,select")) retained.current.add(key);
              }} onPlayCapture={() => retained.current.add(key)}>
              {renderItem(item, index)}
            </div>;
          })}
        </div>
        {footer}
      </div>
    </div>
    {!view.following && <button type="button" onClick={follow}
      className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600 shadow-md">
      ↓ 回到最新
    </button>}
  </div>;
});
