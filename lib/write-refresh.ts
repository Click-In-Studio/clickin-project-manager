"use client";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

/**
 * #416 写后失效 client router cache。
 *
 * 背景：next.config 把 `experimental.staleTimes.dynamic` 从 0 调成了 30s，短时间内
 * 的回头页直接命中 bfcache、零往返。代价是**服务端投喂的 payload 会被缓存 30s**，
 * 而本仓大量组件是 `useState(initialX)` 从服务端 props 播种的——写完切走再切回来，
 * 组件重挂载时会从**写之前**的 payload 重新播种，用户自己的写被打回。
 *
 * `router.refresh()` 会调 `invalidateBfCache()`，清的是**整个 bfcache 而非当前路由**，
 * 所以任何一处 refresh 都能兜住全站。这个模块把「写成功 → 安排一次 refresh」收成一个
 * 与 `fetch` 同签名的薄封装，调用点只需把 `fetch(` 换成 `writeFetch(`，返回值语义不变。
 *
 * 为什么不是 hook：写操作散落在模块级 helper、事件回调、同文件的子组件里，hook 的
 * 调用位置约束会逼着逐个组件插桩。这里改成模块级函数 + 在 AppShell 注册一次 router，
 * 任何作用域都能直接调。
 *
 * 为什么不猴补丁 window.fetch：剧本编辑器和 wiki 文档是按键级自动保存，全局拦截会
 * 变成打字时每隔几百毫秒 refresh 一次整页，正好把本次改动想省的往返又赔回去。显式
 * 替换的代价是新增写点可能漏接——这是明知的取舍，见 PR #474。
 */

let router: AppRouterInstance | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** AppShell 挂载时注册当前 router；返回注销函数。 */
export function registerWriteRefreshRouter(next: AppRouterInstance): () => void {
  router = next;
  return () => {
    if (router === next) router = null;
  };
}

/**
 * 安排一次 refresh。300ms 尾随去抖——与 AgentPopout / WikiShell 既有的兜底刷新同款
 * 节奏，把一次操作里连发的多个写合并成一次往返。刷新本身不阻塞任何 UI：本地
 * setState 已经让当前页正确了，这一次 refresh 只为让**下一次导航**拿到新数据。
 */
export function markWritten(): void {
  if (typeof window === "undefined") return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    router?.refresh();
  }, 300);
}

/** 与 fetch 同签名；成功（res.ok）时额外安排一次 refresh。 */
export async function writeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.ok) markWritten();
  return res;
}

/**
 * 立即刷新，并吃掉待发的去抖刷新。
 *
 * 给这种调用点用：组件本身依赖 refresh 重投喂来更新界面（例如删除后没有本地
 * setState，全靠服务端重新投喂列表），又已经走了 writeFetch。直接写
 * `router.refresh()` 会和 writeFetch 排的那次叠成两趟往返；用这个则只有一趟。
 */
export function refreshNow(): void {
  if (typeof window === "undefined") return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  router?.refresh();
}
