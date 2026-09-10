"use client";

import { createContext, useContext, useEffect } from "react";
import { usePathname } from "next/navigation";

// ─── AI 助手「附带当前对象」的上行通道（#476 follow-up）─────────────────────
//
// AppShell 原来靠 pathname 正则猜当前对象。知识库那条路由猜不动：`[wikiId]` 段
// 共用 uuid 与 `nd_` 两种 id（#358 → #420），`nd_` 到底是资产壳节点还是软链接、
// 链接又指向谁，只有**查过树的人**知道——页面早就分派过一次了（asset 就地预览 /
// link 解到目标），外壳再猜一遍就是猜错（#476 那发 500 即是）。
//
// 所以改成页面（准确说是持有树与选中态的 WikiShell）显式上报，pathname 正则退化
// 为缺省值：树里认得出来的用上报，认不出来的（枚举闭包外经 wikilink 到达的文档，
// 段本来就是 uuid）回落正则。
//
// 上报**连路由一起报**：换页时新页的 effect 与旧页的 cleanup 谁先谁后不由我们决定，
// 拿路由当凭据，撤回只撤自己那条，就不会出现「旧页把新页刚报的抹掉」。

export type AiTargetKind = "wiki" | "asset";

export type AiTargetState = { path: string; kind: AiTargetKind; id: string } | null;

export type ReportAiTarget = (path: string, kind: AiTargetKind | null, id: string | null) => void;

export const AiTargetContext = createContext<ReportAiTarget>(() => {});

/** 纯归约（外壳的 setState 用它，测试直接测它）。 */
export function nextAiTargetState(
  prev: AiTargetState, path: string, kind: AiTargetKind | null, id: string | null,
): AiTargetState {
  if (kind && id) {
    if (prev && prev.path === path && prev.kind === kind && prev.id === id) return prev;
    return { path, kind, id };
  }
  // 撤回：只撤自己那条。无条件清空会在换页时抹掉新页刚上报的目标。
  return prev && prev.path === path ? null : prev;
}

/** 页面侧：声明「本页正在展示的对象」。kind/id 任一为空＝本页没有可附带的对象。 */
export function useReportAiTarget(kind: AiTargetKind | null, id: string | null): void {
  const report = useContext(AiTargetContext);
  const pathname = usePathname();
  useEffect(() => {
    report(pathname, kind, id);
    return () => { report(pathname, null, null); };
  }, [report, pathname, kind, id]);
}
