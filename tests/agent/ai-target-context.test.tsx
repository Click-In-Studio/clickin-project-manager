// @vitest-environment jsdom
//
// #476 follow-up：AI 助手「附带当前对象」的主语改由页面上报，pathname 正则退化
// 为缺省值。这里钉三层——
//   ① 判据（aiTargetForNode）：当前节点 → 带文档还是带文件；
//   ② 归约（nextAiTargetState）：换页时旧页的撤回不许抹掉新页的上报；
//   ③ 接线：hook + Provider 真跑一遍 mount / 换页 / 卸载。
// 再加两条静态棘轮，盯住「外壳优先用上报」和「树侧真的在上报」这两处接线本身——
// 接线断了而判据还绿，是这类改动最典型的假绿。
import { act, useCallback, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";

// act() 要在 act 环境里跑，effect 才是同步冲刷的（否则只是碰巧绿 + 一屏告警）
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pathname = "/production/p1/wiki/w-1";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import {
  AiTargetContext, nextAiTargetState, useReportAiTarget, type AiTargetState,
} from "@/components/agent/ai-target";
import { aiTargetForNode } from "@/lib/node/ai-target";
import type { NodeEntry } from "@/lib/node/db";

function node(partial: Partial<NodeEntry> & { id: string; kind: NodeEntry["kind"] }): NodeEntry {
  return {
    productionId: "p1", parentId: null, sortKey: null, isPublic: false, listable: true,
    wikiId: null, assetId: null, linkTargetId: null, title: null, createdBy: null,
    createdAt: "", updatedAt: "", displayTitle: null, targetTitle: null, targetKind: null,
    targetWikiId: null, tags: [], isAnchor: false, assetFileName: null,
    ...partial,
  };
}

describe("① 判据：当前节点 → 附带什么", () => {
  const wiki = node({ id: "nd_w", kind: "wiki", wikiId: "11111111-1111-4111-8111-111111111111" });
  const asset = node({ id: "nd_a", kind: "asset", assetId: "ast_x1" });
  const byId = new Map([wiki, asset].map(n => [n.id, n]));

  it("wiki 节点带文档，asset 壳节点带文件", () => {
    expect(aiTargetForNode(wiki, byId)).toEqual({ kind: "wiki", id: wiki.wikiId });
    expect(aiTargetForNode(asset, byId)).toEqual({ kind: "asset", id: "ast_x1" });
  });

  it("link 解到目标：wiki 目标用现成的 targetWikiId，asset 目标查树", () => {
    const toWiki = node({
      id: "nd_l1", kind: "link", linkTargetId: "nd_w",
      targetKind: "wiki", targetWikiId: wiki.wikiId,
    });
    const toAsset = node({ id: "nd_l2", kind: "link", linkTargetId: "nd_a", targetKind: "asset" });
    expect(aiTargetForNode(toWiki, byId)).toEqual({ kind: "wiki", id: wiki.wikiId });
    expect(aiTargetForNode(toAsset, byId)).toEqual({ kind: "asset", id: "ast_x1" });
  });

  it("认不出来就不报（folder / 悬空 link / 闭包外的 asset 目标 / 无选中）", () => {
    expect(aiTargetForNode(node({ id: "nd_f", kind: "folder" }), byId)).toBeNull();
    expect(aiTargetForNode(node({ id: "nd_l3", kind: "link", linkTargetId: null }), byId)).toBeNull();
    expect(aiTargetForNode(
      node({ id: "nd_l4", kind: "link", linkTargetId: "nd_missing", targetKind: "asset" }), byId,
    )).toBeNull();
    expect(aiTargetForNode(undefined, byId)).toBeNull();
  });
});

describe("② 归约：撤回只撤自己那条", () => {
  const at = (path: string, id: string): AiTargetState => ({ path, kind: "wiki", id });

  it("上报即覆盖；同值不换引用（省一次重渲染）", () => {
    const first = nextAiTargetState(null, "/a", "wiki", "w1");
    expect(first).toEqual(at("/a", "w1"));
    expect(nextAiTargetState(first, "/a", "wiki", "w1")).toBe(first);
    expect(nextAiTargetState(first, "/a", "asset", "ast_1")).toEqual({ path: "/a", kind: "asset", id: "ast_1" });
  });

  it("旧页的 cleanup 晚到，不许抹掉新页刚报的（换页时序不由我们决定）", () => {
    const fresh = nextAiTargetState(at("/a", "w1"), "/b", "wiki", "w2");
    expect(nextAiTargetState(fresh, "/a", null, null)).toBe(fresh);
  });

  it("自己那条的 cleanup 正常清空", () => {
    expect(nextAiTargetState(at("/a", "w1"), "/a", null, null)).toBeNull();
  });
});

describe("③ 接线：hook + Provider 真跑一遍", () => {
  let container: HTMLDivElement;
  let root: Root;

  /** AppShell 的上报接线等价物（状态 + 归约 + 按路由认领）。 */
  function Shell({ children }: { children: ReactNode }) {
    const [target, setTarget] = useState<AiTargetState>(null);
    const report = useCallback(
      (path: string, kind: "wiki" | "asset" | null, id: string | null) =>
        setTarget(prev => nextAiTargetState(prev, path, kind, id)),
      [],
    );
    const active = target && target.path === pathname ? target : null;
    return (
      <AiTargetContext.Provider value={report}>
        <div data-testid="probe" data-target={active ? `${active.kind}:${active.id}` : ""} />
        {children}
      </AiTargetContext.Provider>
    );
  }

  function Page({ kind, id }: { kind: "wiki" | "asset" | null; id: string | null }) {
    useReportAiTarget(kind, id);
    return null;
  }

  const probe = () => container.querySelector("[data-testid=probe]")!.getAttribute("data-target");

  beforeEach(() => {
    pathname = "/production/p1/wiki/w-1";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("挂载即上报；换到资产壳节点页换成带文件；离开则清空", () => {
    act(() => { root.render(<Shell><Page key="w-1" kind="wiki" id="w-1" /></Shell>); });
    expect(probe()).toBe("wiki:w-1");

    // 换页：路由先变，旧页卸载与新页挂载同一次提交里发生
    pathname = "/production/p1/wiki/nd_asset";
    act(() => { root.render(<Shell><Page key="nd_asset" kind="asset" id="ast_x1" /></Shell>); });
    expect(probe()).toBe("asset:ast_x1");

    // 走到一个不上报的页面（树里认不出来）：清空，交给 pathname 正则兜底
    pathname = "/production/p1/tasks";
    act(() => { root.render(<Shell><Page key="tasks" kind={null} id={null} /></Shell>); });
    expect(probe()).toBe("");
  });

  it("上报者整个卸载后不留残影", () => {
    act(() => { root.render(<Shell><Page key="w-1" kind="wiki" id="w-1" /></Shell>); });
    expect(probe()).toBe("wiki:w-1");
    act(() => { root.render(<Shell>{null}</Shell>); });
    expect(probe()).toBe("");
  });
});

describe("④ 接线棘轮", () => {
  it("AppShell 的 currentWikiId/currentAssetId 以上报为先、正则为后", () => {
    const src = readFileSync("components/shell/AppShell.tsx", "utf8");
    expect(src).toContain("nextAiTargetState");
    expect(src).toContain("<AiTargetContext.Provider value={reportAiTarget}>");
    // 裸 `= productionId ? extractCurrentXxx(...)` 就是回到 #476 之前的形状
    for (const line of ["const currentWikiId = activeAiTarget", "const currentAssetId = activeAiTarget"]) {
      expect(src).toContain(line);
    }
  });

  it("WikiShell 真的在上报（判据绿而接线断是这类改动最典型的假绿）", () => {
    const src = readFileSync("components/wiki/WikiShell.tsx", "utf8");
    expect(src).toMatch(/useReportAiTarget\(\s*aiTarget\?\.kind \?\? null,\s*aiTarget\?\.id \?\? null,?\s*\)/);
    expect(src).toContain("aiTargetForNode(selectedItem, byId)");
  });
});
