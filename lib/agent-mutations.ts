"use client";

// 「写操作后自动刷新」在自建 agent 环境下的通用机制（前端半边）。
//
// runner 在写工具成功后往 agent SSE 上多发一行 `mutation`（见 lib/agent-runtime/tools.ts 的
// `mutates` 声明与 service.ts 的发行），AgentPopout 收到后**只做派发**：页面/组件通过
// useAgentMutation 订阅自己关心的 scope，handler 自己决定刷新粒度——client 页面重拉
// 那一个 API、server component 页面 router.refresh()、带 ids 的只在命中时动。
// 没有任何订阅者命中时 AgentPopout 兜底 router.refresh()，保证新页面零配置也不会"完全不刷"。
//
// 为什么不直接在 AgentPopout 里 router.refresh()：刷新范围越小越自然；而且以后各页面
// 未必都有像 wiki 那样自己的协作 SSE，agent SSE 是每个页面都有的那条通道。

import { useEffect, useRef } from "react";

export type MutationAction = "created" | "updated" | "deleted";

export interface AgentMutation {
  /** 领域：wiki / instructions.personal / instructions.production / …（与 runner 侧 mutates 声明同源） */
  scope: string;
  action: MutationAction;
  productionId?: string | null;
  /** 受影响实体 id（可缺席 = 该 scope 整体变了） */
  ids?: string[];
  /** 触发的工具名（调试/日志用） */
  tool?: string;
}

export interface MutationFilter {
  scope: string;
  /** 缺席 = 不按制作过滤 */
  productionId?: string | null;
}

type Handler = (m: AgentMutation) => void;
type Sub = { filter: MutationFilter; handler: Handler };

const subs = new Set<Sub>();

// 订阅方给了 productionId 就必须与信号的一致——信号没带制作（null）也算不一致，
// 免得个人域的信号刷到所有制作页面（AI review #374）。不按制作过滤的订阅不传 productionId。
function matches(f: MutationFilter, m: AgentMutation): boolean {
  if (f.scope !== m.scope) return false;
  if (f.productionId != null && m.productionId !== f.productionId) return false;
  return true;
}

/** 派发给所有命中的订阅者；返回是否有人接了（没人接 → 调用方兜底） */
export function dispatchAgentMutation(m: AgentMutation): boolean {
  let handled = false;
  for (const s of subs) {
    if (!matches(s.filter, m)) continue;
    handled = true;
    try { s.handler(m); } catch (err) { console.error("[agent-mutations] handler failed:", err); }
  }
  return handled;
}

/** 非 React 场景的订阅（返回退订） */
export function subscribeAgentMutation(filter: MutationFilter, handler: Handler): () => void {
  const s: Sub = { filter, handler };
  subs.add(s);
  return () => { subs.delete(s); };
}

/**
 * 组件订阅：handler 每次都取最新引用（不用把它放进依赖数组）。
 * 例：useAgentMutation({ scope: "wiki", productionId }, () => router.refresh());
 */
export function useAgentMutation(filter: MutationFilter, handler: Handler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const { scope, productionId } = filter;
  useEffect(
    () => subscribeAgentMutation({ scope, productionId }, (m) => handlerRef.current(m)),
    [scope, productionId],
  );
}

/** 测试用 */
export function _resetAgentMutationSubscribers(): void {
  subs.clear();
}
