/**
 * sse-kick.ts — 权限撤销主动断流（#469）。
 *
 * 三条协作流（script / cue / wiki）只在建连时过权限门，此后到断连为止不再重校验：
 * 成员被停用、移出、收权后，已建立的流照常收 seq / presence / 正文广播，#460 快路径
 * 下还能继续写 presence。#465 keepalive 之后流不再被 nginx 60s 掐断，这个窗口就是
 * 标签页保持可见的全部时长。
 *
 * 修法是「踢一脚」而不是周期重校验：撤销写点按 (production, user) 反查这里的注册表，
 * 主动关掉连接。EventSource 自动重连会重新过建连门，403 即停——状态天然收敛。
 * 多踢无害（重连一次 + onReopen 补拉一次），所以写点不必精确映射「哪种权限对应哪条
 * 流」：撤销某人就踢他在该 production 的全部流，影响多人的写点（部门权限、角色权限）
 * 踢整个 production。
 *
 * 与 sse-keepalive 同款：横切注册表，三条路由各自在建连处登记。`close` 由路由提供，
 * 必须包含与 stream cancel() 相同的整套清理（注册表摘除、presence 移除、keepalive
 * 释放）再 controller.close()——服务端主动 close 不会触发 cancel()。
 *
 * 只管本进程。跨进程（agent-runner 收 wiki 分享）走 lib/wiki/collab.ts 的 outbox 桥，
 * 到达持有连接的进程后再调这里的 kickUserStreams。
 */

type KickEntry = { userId: string; close: () => void };

const g = global as typeof globalThis & {
  __sseKickRegistry?: Map<string, Set<KickEntry>>;
};

function registry(): Map<string, Set<KickEntry>> {
  if (!g.__sseKickRegistry) g.__sseKickRegistry = new Map();
  return g.__sseKickRegistry;
}

/**
 * 登记一条可被踢的连接，返回注销函数（幂等）。
 * 路由在 cancel() 里注销；被踢时注册表先摘再 close，close 里再调注销是空操作。
 */
export function registerSSEKick(productionId: string, userId: string, close: () => void): () => void {
  const reg = registry();
  let set = reg.get(productionId);
  if (!set) { set = new Set(); reg.set(productionId, set); }
  const entry: KickEntry = { userId, close };
  set.add(entry);
  return () => {
    const s = reg.get(productionId);
    if (!s) return;
    s.delete(entry);
    if (s.size === 0) reg.delete(productionId);
  };
}

/**
 * 断开某人在该 production 的全部在册流；userId 省略 = 整个 production。
 * 返回关掉的连接数。close 抛错只记日志：一条坏连接不能挡住其余的踢出。
 */
export function kickUserStreams(productionId: string, userId?: string): number {
  const set = registry().get(productionId);
  if (!set) return 0;
  const victims = [...set].filter((e) => userId === undefined || e.userId === userId);
  for (const e of victims) set.delete(e);
  if (set.size === 0) registry().delete(productionId);
  for (const e of victims) {
    try { e.close(); } catch (err) { console.error("[sse-kick] close failed:", err); }
  }
  return victims.length;
}

/** 测试用：该 production（可选限定 user）在册连接数。 */
export function countKickableStreams(productionId: string, userId?: string): number {
  const set = registry().get(productionId);
  if (!set) return 0;
  if (userId === undefined) return set.size;
  let n = 0;
  for (const e of set) if (e.userId === userId) n++;
  return n;
}
