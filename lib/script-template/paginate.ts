/**
 * 分页器：唯一的一份（docs/script-template-engine.md §3）。
 *
 * 输入是 LayoutItem 与「取高函数」——估算器给几何估算，测量层给 DOM 实测——
 * 算法只有这一份。今天 computePageMap 与 computePrintPages 是两套各写各的，
 * 连说话人间距都一个算一个不算；引擎里差别只剩高度来源与 `countGapBefore` 开关。
 */
import type { Scene } from "../script-types";
import type { LayoutItem } from "./types";

export type HeightOf = (item: LayoutItem, variant: "normal" | "pageTop") => number;

export type PlacedItem = { item: LayoutItem; variant: "normal" | "pageTop"; gapBefore: number };
export type Page = {
  pageNum: number;
  items: PlacedItem[];
  /** 本页首个正文块所在场次的标签（页眉用） */
  sceneLabel: string;
  /** 本页首个正文块所在的场（页眉的幕/场字段用；估算器路径下为 null） */
  scene: Scene | null;
};

export type PaginateOptions = {
  contentHeight: number;
  heightOf: HeightOf;
  /** 说话人间距是否计入高度（legacy 估算器不计） */
  countGapBefore: boolean;
};

export type PaginateResult = {
  pages: Page[];
  pageMap: Record<string, number>;
  scenePageNums: Record<string, number>;
};

export function paginate(items: LayoutItem[], opts: PaginateOptions): PaginateResult {
  const { contentHeight, heightOf, countGapBefore } = opts;
  const pages: Page[] = [];
  const pageMap: Record<string, number> = {};
  const scenePageNums: Record<string, number> = {};

  let pageNum = 1;
  let used = 0;
  let hasBlockOnPage = false;
  let cur: PlacedItem[] = [];
  let curLabel = "";
  let curScene: Scene | null = null;
  let activeSceneLabel = "";
  let activeScene: Scene | null = null;

  const flush = () => {
    if (cur.length === 0) return;
    pages.push({ pageNum, items: cur, sceneLabel: curLabel, scene: curScene });
    pageNum++;
    cur = [];
    used = 0;
    hasBlockOnPage = false;
    curLabel = "";
    curScene = null;
  };

  for (const item of items) {
    if (item.kind === "sceneHeading") {
      activeSceneLabel = item.scene?.number ?? "";
      activeScene = item.scene;
      const h = heightOf(item, "normal");
      // 每场另起页：页上已有东西就翻
      if (item.breakBefore && used > 0) flush();
      // legacy 两条算法都是「页上已有东西才翻页」：空页上放不下也硬放
      else if (used > 0 && used + h > contentHeight) flush();
      cur.push({ item, variant: "normal", gapBefore: 0 });
      used += h;
      if (!(item.sceneId in scenePageNums)) scenePageNums[item.sceneId] = pageNum;
      continue;
    }

    if (item.breakBefore && used > 0) flush();

    let variant: "normal" | "pageTop" = hasBlockOnPage ? "normal" : "pageTop";
    let gap = hasBlockOnPage && countGapBefore ? item.gapBefore : 0;
    let h = heightOf(item, variant) + gap;
    if (used > 0 && used + h > contentHeight) {
      flush();
      variant = "pageTop";
      gap = 0;
      h = heightOf(item, variant);
    }
    if (!hasBlockOnPage) { curLabel = activeSceneLabel; curScene = activeScene; }
    cur.push({ item, variant, gapBefore: hasBlockOnPage ? item.gapBefore : 0 });
    pageMap[item.block.id] = pageNum;
    used += h;
    hasBlockOnPage = true;
  }
  flush();
  return { pages, pageMap, scenePageNums };
}
