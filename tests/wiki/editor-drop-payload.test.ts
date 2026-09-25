// 「从树拖进正文」的载荷（#692）：树端写、编辑器端读，两端同源。
//
// 断言的是形状契约：树条目 → 引用（锚真实目标）、写进 dataTransfer 的两个通道、
// 读回时对坏数据的态度（不是我们的拖拽就 null，别把别人的 drop 吞了）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  treeDragRef, writeDragRef, readDragRef, dragRefMentionAttrs,
  WIKI_DRAG_MIME, ASSET_DRAG_MIME,
} from "@/lib/editor/editor-drop-payload";

const base = { wikiId: null, assetId: null, targetWikiId: null, displayTitle: null };

class FakeDT {
  data = new Map<string, string>();
  setData(t: string, d: string) { this.data.set(t, d); }
  getData(t: string) { return this.data.get(t) ?? ""; }
}

describe("树条目 → 拖拽引用", () => {
  it("wiki 节点锚 wikiId", () => {
    expect(treeDragRef({ ...base, kind: "wiki", wikiId: "w1", displayTitle: "排练计划" }))
      .toEqual({ kind: "wiki", id: "w1", label: "排练计划" });
  });
  it("软链接锚目标 wikiId，不锚链接节点自己（#358 ⑦）", () => {
    expect(treeDragRef({ ...base, kind: "link", targetWikiId: "w9", displayTitle: "别名" }))
      .toEqual({ kind: "wiki", id: "w9", label: "别名" });
  });
  it("asset 节点锚 assetId", () => {
    expect(treeDragRef({ ...base, kind: "asset", assetId: "as1", displayTitle: "剧照.jpg" }))
      .toEqual({ kind: "asset", id: "as1", label: "剧照.jpg" });
  });
  it("folder、指向素材的软链接、缺 id 的节点：不成引用", () => {
    expect(treeDragRef({ ...base, kind: "folder", displayTitle: "道具" })).toBeNull();
    expect(treeDragRef({ ...base, kind: "link", displayTitle: "→素材" })).toBeNull();
    expect(treeDragRef({ ...base, kind: "asset", displayTitle: "坏节点" })).toBeNull();
  });
  it("没标题给「（无标题）」占位，不给空串（chip 上不能没字）", () => {
    expect(treeDragRef({ ...base, kind: "wiki", wikiId: "w1" })!.label).toBe("（无标题）");
  });
});

describe("dataTransfer 往返", () => {
  it("wiki：私有 mime + text/plain 的引用哨兵，读回原样", () => {
    const dt = new FakeDT();
    writeDragRef(dt, { kind: "wiki", id: "w1", label: "排练计划" });
    expect(dt.getData("text/plain")).toBe("[#](/__cm__/wiki/w1)");
    expect(dt.getData(ASSET_DRAG_MIME)).toBe("");
    expect(readDragRef(dt)).toEqual({ kind: "wiki", id: "w1", label: "排练计划" });
  });
  it("asset：走另一个 mime，text/plain 同样是引用哨兵", () => {
    const dt = new FakeDT();
    writeDragRef(dt, { kind: "asset", id: "as1", label: "剧照.jpg" });
    expect(dt.getData("text/plain")).toBe("[#](/__cm__/asset/as1)");
    expect(dt.getData(WIKI_DRAG_MIME)).toBe("");
    expect(readDragRef(dt)).toEqual({ kind: "asset", id: "as1", label: "剧照.jpg" });
  });
  it("不是我们的拖拽（两个 mime 都没有）→ null，让浏览器 / 其它插件处理", () => {
    expect(readDragRef(new FakeDT())).toBeNull();
    expect(readDragRef(null)).toBeNull();
    expect(readDragRef(undefined)).toBeNull();
  });
  it("JSON 坏了或没 id → null，不抛", () => {
    const bad = new FakeDT();
    bad.setData(WIKI_DRAG_MIME, "{not json");
    expect(readDragRef(bad)).toBeNull();
    const noId = new FakeDT();
    noId.setData(ASSET_DRAG_MIME, JSON.stringify({ label: "x" }));
    expect(readDragRef(noId)).toBeNull();
  });
  it("label 缺失时按 kind 给占位词", () => {
    const dt = new FakeDT();
    dt.setData(ASSET_DRAG_MIME, JSON.stringify({ id: "as1" }));
    expect(readDragRef(dt)!.label).toBe("素材");
  });
});

describe("落成 contentMention attrs", () => {
  it("kind / id / label 进 attrs，其余位为 null（不带 aux：拖来的是素材本体不是挂载）", () => {
    expect(dragRefMentionAttrs({ kind: "asset", id: "as1", label: "剧照.jpg" })).toEqual({
      kind: "asset", displayMode: null, id: "as1", aux: null, versionId: null, label: "剧照.jpg",
    });
  });
});

describe("接线棘轮：两端都只认这个模块", () => {
  it("WikiShell 的 dragStart 走 treeDragRef + writeDragRef，不再手写 mime 字符串", () => {
    const src = readFileSync("components/wiki/WikiShell.tsx", "utf8");
    expect(src).toContain("treeDragRef(item)");
    expect(src).toContain("writeDragRef(e.dataTransfer, ref)");
    expect(src).not.toContain("application/x-clickin-");
  });
  it("SmartTextarea 的 handleDrop 走 readDragRef + dragRefMentionAttrs", () => {
    const src = readFileSync("components/editor/SmartTextarea.tsx", "utf8");
    expect(src).toContain("readDragRef(event.dataTransfer)");
    expect(src).toContain("contentMention.create(dragRefMentionAttrs(ref))");
    expect(src).not.toContain("application/x-clickin-");
  });
});
