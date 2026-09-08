/**
 * sse-keepalive.ts — SSE 周期注释帧（#465）。
 *
 * script/cue/wiki 三条协作流建连后只发一帧 `: connected`，空闲 60s 会被
 * nginx 默认 proxy_read_timeout 掐断，触发 EventSource 静默重连——每个空闲
 * 协作者每分钟一轮「断连→重跑建连权限门→重新入场」循环。周期注释帧
 * （EventSource 忽略冒号开头的行）让连接永不空闲，治本且不依赖运维配置。
 *
 * 全站共享一个 setInterval 扫在册 push 集合，不是每连接一个 timer。
 * 引用计数是给 wiki 路由的：doc/library 两个 topic 复用同一个 push 函数，
 * 双注册只该发一份 ping、两个 cleanup 都释放后才真正移除。
 */

type SSEPush = (frame: string) => void;

export const SSE_KEEPALIVE_INTERVAL_MS = 25_000;
const KEEPALIVE_FRAME = `: ping\n\n`;

const g = global as typeof globalThis & {
  __sseKeepaliveClients?: Map<SSEPush, number>;
  __sseKeepaliveTimer?: ReturnType<typeof setInterval> | null;
};

function clients(): Map<SSEPush, number> {
  if (!g.__sseKeepaliveClients) g.__sseKeepaliveClients = new Map();
  return g.__sseKeepaliveClients;
}

/** 给所有在册连接发一帧注释；坏管道由各路由 push 包装的 catch 触发清理。 */
export function sseKeepaliveTick(): void {
  for (const push of clients().keys()) {
    try { push(KEEPALIVE_FRAME); } catch { /* push 自带 try/catch，双保险 */ }
  }
}

/**
 * 把一个 SSE 连接的 push 纳入 keepalive 扫描，返回释放函数。
 * 释放函数幂等：路由的 push 错误路径和 stream cancel() 会各调一次 cleanup，
 * 不做幂等会把引用计数多减，误伤 wiki 的双 topic 注册。
 */
export function registerSSEKeepalive(push: SSEPush): () => void {
  const m = clients();
  m.set(push, (m.get(push) ?? 0) + 1);
  if (!g.__sseKeepaliveTimer) {
    const timer = setInterval(sseKeepaliveTick, SSE_KEEPALIVE_INTERVAL_MS);
    timer.unref?.();
    g.__sseKeepaliveTimer = timer;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = m.get(push);
    if (n === undefined) return;
    if (n <= 1) m.delete(push);
    else m.set(push, n - 1);
    if (m.size === 0 && g.__sseKeepaliveTimer) {
      clearInterval(g.__sseKeepaliveTimer);
      g.__sseKeepaliveTimer = null;
    }
  };
}
