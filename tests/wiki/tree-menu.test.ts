import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { treeMenuItems, TREE_MENU_ORDER, type TreeMenuCtx } from "@/lib/node/tree-menu";
import type { NodeEntry } from "@/lib/node/db";

// #511 文档树 ⋯ 菜单：四 kind 同一套项、同一顺序；不支持的灰掉给原因，不消失。
// 这是设计原则（用户拍板：「无入口应该灰掉不应该消失」），所以钉的是**项表形状**，
// 不是某一项的文案。

function node(partial: Partial<NodeEntry> & { kind: NodeEntry["kind"] }): NodeEntry {
  return {
    id: "nd_x", productionId: "p1", parentId: null, sortKey: null, isPublic: false, listable: true,
    wikiId: null, assetId: null, linkTargetId: null, title: null, createdBy: null,
    createdAt: "", updatedAt: "", displayTitle: null, targetTitle: null, targetKind: null,
    targetWikiId: null, tags: [], isAnchor: false, assetFileName: null,
    ...partial,
  };
}
const wiki = node({ kind: "wiki", wikiId: "w1" });
const asset = node({ kind: "asset", assetId: "a1", createdBy: "u1" });
const link = node({ kind: "link", linkTargetId: "nd_w" });
const folder = node({ kind: "folder" });
const anchor = node({ kind: "folder", isAnchor: true });
const full = { canCreate: true, assetActions: { a1: { rename: true, delete: true } } };

describe("统一：每种 kind 的项表 key 序列完全一致", () => {
  it.each([["wiki", wiki], ["asset", asset], ["link", link], ["folder", folder], ["anchor", anchor]] as const)(
    "%s", (_name, n) => {
      expect(treeMenuItems(n, full).map(i => i.key)).toEqual([...TREE_MENU_ORDER]);
      expect(treeMenuItems(n, { canCreate: false }).map(i => i.key)).toEqual([...TREE_MENU_ORDER]);
    });
});

const enabled = (n: NodeEntry, ctx: TreeMenuCtx = full) =>
  treeMenuItems(n, ctx).filter(i => i.disabledReason === undefined).map(i => i.key);
const reasons = (n: NodeEntry, ctx: TreeMenuCtx = full) =>
  Object.fromEntries(treeMenuItems(n, ctx).filter(i => i.disabledReason).map(i => [i.key, i.disabledReason]));

describe("可用集：按 kind 的能力面", () => {
  it("wiki：重命名 / 副本 / 移动 / 链接 / 删除；「改回目标标题」灰（仅链接）", () => {
    expect(enabled(wiki)).toEqual(["rename", "duplicate", "move", "link", "delete"]);
    expect(reasons(wiki).resetTitle).toBeTruthy();
  });
  it("asset（持重命名与删除权）：重命名 / 移动 / 链接 / 删除；副本灰", () => {
    expect(enabled(asset)).toEqual(["rename", "move", "link", "delete"]);
    expect(reasons(asset).duplicate).toBeTruthy();
  });
  it("资产只持单枚键时，重命名与删除分别开关；创建者身份不代替授权", () => {
    const ctx = { canCreate: true };
    expect(enabled(asset, ctx)).toEqual(["move", "link"]);
    expect(reasons(asset, ctx).rename).toMatch(/权限/);
    expect(reasons(asset, ctx).delete).toMatch(/权限/);
    expect(enabled(asset, { ...ctx, assetActions: { a1: { rename: true, delete: false } } }))
      .toEqual(["rename", "move", "link"]);
    expect(enabled(asset, { ...ctx, assetActions: { a1: { rename: false, delete: true } } }))
      .toEqual(["move", "link", "delete"]);
  });
  it("link：重命名 / 移动 / 移除链接；带别名时「改回目标标题」亮、无别名时灰", () => {
    expect(enabled(link)).toEqual(["rename", "move", "delete"]);
    expect(treeMenuItems(link, full).find(i => i.key === "delete")!.label).toBe("移除链接");
    expect(enabled(node({ ...link, title: "别名" }))).toEqual(["rename", "resetTitle", "move", "delete"]);
  });
  it("folder：只有移动；锚点目录的删除原因说明是系统目录", () => {
    expect(enabled(folder)).toEqual(["move"]);
    expect(reasons(anchor).delete).toMatch(/系统目录/);
  });
  it("无 create 权限：副本与链接一起灰，原因是权限；其余不受影响", () => {
    const ctx = { ...full, canCreate: false };
    expect(enabled(wiki, ctx)).toEqual(["rename", "move", "delete"]);
    expect(reasons(wiki, ctx).duplicate).toMatch(/权限/);
    expect(reasons(wiki, ctx).link).toMatch(/权限/);
  });
});

describe("每个灰项都有原因；每个原因都不是空串", () => {
  it.each([wiki, asset, link, folder, anchor])("kind=%o", n => {
    for (const i of treeMenuItems(n, { canCreate: false })) {
      if (i.disabledReason !== undefined) expect(i.disabledReason.length).toBeGreaterThan(0);
    }
  });
});

describe("接线棘轮：WikiShell 的 ⋯ 菜单真的从项表渲染，且灰化不靠 disabled 属性", () => {
  const src = readFileSync("components/wiki/WikiShell.tsx", "utf8");
  it("渲染走 treeMenuItems，不再按 kind 条件渲染菜单项", () => {
    expect(src).toMatch(/treeMenuItems\(it, \{ canCreate, assetActions \}\)/);
  });
  it("灰化用 aria-disabled（disabled 的按钮不冒鼠标事件，title 里的原因读不到）", () => {
    const menu = src.slice(src.indexOf("treeMenuItems(it,"), src.indexOf("document.body,"));
    expect(menu).toMatch(/aria-disabled=/);
    expect(menu).not.toMatch(/\sdisabled=/);
    expect(menu).toMatch(/title=\{mi\.disabledReason\}/);
  });
});
