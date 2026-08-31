// 剧本编辑器的 focus 状态通道（ScriptEditor → AgentPopout）。
//
// AI 信封（lib/agent-ui-context.ts）的剧本 focus 上下文从这里取：编辑器把
// 「当前选中/聚焦的块 id」发布到模块级单例，popout 订阅后作为 chip 展示并随
// 消息附带。选择 window 事件之外的模块单例：popout 常驻挂载但可能晚于编辑器
// 首次发布，事件会漏掉初值，单例 + 订阅不会。
//
// 只带指针不带正文（与 wiki 文档 chip 同款原则）：id 让 AI 用
// production.script_read_window 自己读，正文不塞进每条消息。
// 信封可被用户摘除、可被伪造——伪造只能谎报「聚焦了哪个块」，读写权限门
// 都在工具内部，无提权（与 agent-ui-context.ts 既有威胁模型同构）。

export type ScriptFocusKind =
  /** 显式多选/单选 */
  | "selection"
  /** 光标（编辑焦点）所在块 */
  | "caret"
  /** 纯浏览：视野顶部的块（无选区无光标时的兜底——「正在看哪」也要能感知） */
  | "viewport";

export type ScriptFocusInfo = {
  kind: ScriptFocusKind;
  /** 选中/聚焦的块 id（最多前 5 个） */
  blockIds: string[];
  /** 实际选中总数（多选可能超过 blockIds 携带数） */
  total: number;
};

let current: ScriptFocusInfo | null = null;
const listeners = new Set<() => void>();

function same(a: ScriptFocusInfo | null, b: ScriptFocusInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.total === b.total && a.blockIds.length === b.blockIds.length && a.blockIds.every((id, i) => id === b.blockIds[i]);
}

export function publishScriptFocus(info: ScriptFocusInfo | null): void {
  if (same(current, info)) return; // 引用稳定：useSyncExternalStore 的 getSnapshot 依赖它
  current = info;
  for (const l of listeners) l();
}

export function getScriptFocus(): ScriptFocusInfo | null {
  return current;
}

export function getServerScriptFocus(): null {
  return null; // SSR 快照恒为空（focus 是纯浏览器态）
}

export function subscribeScriptFocus(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
