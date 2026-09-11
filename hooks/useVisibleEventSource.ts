"use client";
import { useEffect, useRef, useState } from "react";

/**
 * useVisibleEventSource — 可见性门控的 SSE 连接（#467）。
 *
 * 浏览器对同源 HTTP/1.1 只给 6 条并发连接，而协作 SSE 是常驻长连接：剧本 +
 * Cue + 几篇 wiki + AI 侧栏同开就能顶满，此后**所有同源请求排队**、整页静默
 * 卡死（网关时代出过一次事故，见 app/api/agent/chat/stream/route.ts 的注释）。
 * 后台标签不释放连接是主要浪费来源——人看不见的页面不需要实时。
 *
 * 门控另有一层与性能无关的收益：连接即在场。后台标签常驻连接会让协作头像里
 * 躺着一堆其实没在看的人，presence 因此失真。
 */

/** 页面是否可见（后台标签 = false）。SSR 期恒 true，避免首帧水合抖动。 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === "visible");
    // 挂载时补一次：SSR 恒 true，首帧就在后台标签的话要立刻纠正
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}

export type VisibleEventSourceHandlers = {
  /**
   * **重连补齐**挂载点：第二次及以后每次连上都调一次，首次建连不调。
   *
   * SSE 广播不补发历史帧——隐藏期间（以及网络/反代掐断期间）别人的改动帧直接
   * 丢失，切回标签页看到的会是陈旧内容，甚至拿陈旧 base 去做合并覆盖别人。所以
   * 断开重连的消费方必须在这里主动拉一次最新态。
   *
   * 跳过首次是因为首次建连紧跟着页面自己的初始数据加载，窗口只有几百毫秒，
   * 补齐的收益抵不过每次开页多一轮请求。
   *
   * 例外：script stream 不需要它——那条流在建连帧里就带当前 seq，客户端比对
   * 版本号即可，比无条件重拉便宜得多。没有版本号的流（cue / wiki）才走这里。
   */
  onReopen?: () => void;
  /**
   * 连接关闭时调用（页面隐藏 / 组件卸载 / url 变更）。
   * 给在场者快照用：连接一断，服务端就把本端移出在场表，本地那份名单立刻过期。
   */
  onClose?: () => void;
  /** 具名事件监听器；`message` 键对应无 `event:` 名的默认帧。 */
  listeners: Record<string, (e: MessageEvent) => void>;
};

/**
 * 可见时建连、隐藏即断。`url` 传 null 表示条件未就绪，不建连。
 *
 * 回调经 ref 取最新，effect 只依赖 url——否则调用方每次渲染新建的 listeners
 * 对象都会重连一次。**代价**：事件名集合在建连时快照，运行期增删事件名不会重绑
 * （四处消费方都是固定键集合）。
 */
export function useVisibleEventSource(url: string | null, handlers: VisibleEventSourceHandlers): void {
  const visible = useDocumentVisible();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  // 首次 open 不算重连；跨可见性周期保留，否则每次切回标签都被当成首次
  const openedRef = useRef(false);

  useEffect(() => {
    if (!url || !visible) return;
    const es = new EventSource(url);
    const bound: Array<[string, EventListener]> = [];
    const bind = (type: string, fn: EventListener) => {
      es.addEventListener(type, fn);
      bound.push([type, fn]);
    };

    bind("open", () => {
      if (openedRef.current) handlersRef.current.onReopen?.();
      openedRef.current = true;
    });
    for (const type of Object.keys(handlersRef.current.listeners)) {
      bind(type, (e: Event) => handlersRef.current.listeners[type]?.(e as MessageEvent));
    }

    return () => {
      for (const [type, fn] of bound) es.removeEventListener(type, fn);
      es.close();
      handlersRef.current.onClose?.();
    };
  }, [url, visible]);
}
