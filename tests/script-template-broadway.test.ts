/**
 * 百老汇音乐剧模版（broadway-musical@1）按 Samuel French 规范逐条对照——在 plan / estimate /
 * paginate 层面钉，不依赖 DOM：
 *   · 角色名与简短提示连成一行居中（`JOHN (laughing)`）；长提示另起一行三个 indent
 *   · 台词左对齐通栏；歌词全大写一个 indent；舞台指示括号内、左右各三个 indent
 *   · speech 之间空一行；连续同角色省名
 *   · 每场另起页；页首续说补 `(Cont.)`
 *   · 页眉 `I – 1 – N`（幕–场–页）右上，无页脚，无目录
 * 也是第一个**非 legacy** 模版：它证明引擎的原语（行内流 / 缩进 / when / 幕场字段）够用。
 */
import { describe, it, expect } from "vitest";
import type { Block, Scene } from "@/lib/script-types";
import {
  estimateItemHeight, paginate, planBlock, planScript, sceneNumberParts, toRoman, templateById,
  type LayoutItem, type PlanContext,
} from "@/lib/script-template";
import { pageBandText } from "@/components/print/template-render";

const T = templateById("broadway-musical@1");
const characters = [{ id: "john", name: "John", isAggregate: false }, { id: "jane", name: "Jane", isAggregate: false }];
const scenes: Scene[] = [
  { id: "ch0", number: "0", name: "", parentId: null },
  { id: "sc0-1", number: "0-1", name: "", parentId: "ch0" },
  { id: "sc0-2", number: "0-2", name: "", parentId: "ch0" },
  { id: "ch1", number: "1", name: "", parentId: null },
];
const ctx: PlanContext = { template: T, characters, scenes, stageDelimOpen: "(", stageDelimClose: ")" };

function block(over: Partial<Block>): Block {
  return { id: "b", type: "dialogue", content: "", characterIds: [], characterAnnotations: {}, lyric: false, sceneId: "sc0-1", rehearsalMark: null, ...over };
}
const slotsOf = (item: LayoutItem, v: "normal" | "pageTop" = "normal") => {
  const variant = v === "pageTop" ? item.pageTop : item.normal;
  return item.slots.filter((s) => !variant.hidden.has(s.slot.id) && !(s.empty && (s.slot.hideIfEmpty ?? true) && !s.parts.some((p) => p.field === "content")));
};
const CONTENT_W = 644;
const H = (item: LayoutItem, v: "normal" | "pageTop" = "normal") => estimateItemHeight(item, v, CONTENT_W, T.estimate);

describe("幕 / 场字段", () => {
  it("章-场 生成号 → 幕的罗马数字与场在幕内的序号", () => {
    expect(toRoman(1)).toBe("I"); expect(toRoman(4)).toBe("IV"); expect(toRoman(12)).toBe("XII");
    expect(sceneNumberParts("0-1")).toEqual({ actRoman: "I", local: "1" });
    expect(sceneNumberParts("1-3")).toEqual({ actRoman: "II", local: "3" });
    expect(sceneNumberParts("0")).toEqual({ actRoman: "I", local: "" });
  });
});

describe("对白块", () => {
  it("角色名全大写居中；简短提示与它同一行（两个 inline 槽连成文字流）", () => {
    const item = planBlock(block({ id: "b1", characterIds: ["john"], stageComment: "laughing", content: "Text would go here." }), null, ctx);
    const ids = slotsOf(item).map((s) => s.slot.id);
    expect(ids).toEqual(["character", "briefComment", "content"]);
    const [name, brief] = slotsOf(item);
    expect(name.slot.inline && brief.slot.inline).toBe(true);
    expect(name.slot.style.case).toBe("upper");
    expect(name.slot.style.align).toBe("center");
    expect(brief.text).toBe("(laughing)");
    // 名字行一行 + 台词一行
    expect(H(item)).toBe(26 + 26);
  });

  it("长提示另起一行、缩进三个 indent、括号内", () => {
    const item = planBlock(block({ id: "b2", characterIds: ["john"], stageComment: "Tosses keys across room while laughing at nothing", content: "Hi." }), null, ctx);
    const ids = slotsOf(item).map((s) => s.slot.id);
    expect(ids).toEqual(["character", "longComment", "content"]);
    const long = slotsOf(item)[1];
    expect(long.slot.indent?.left).toBe(48 * 3);
    expect(long.text).toBe("(Tosses keys across room while laughing at nothing)");
    expect(H(item)).toBe(26 * 3);
  });

  it("台词左对齐通栏；歌词全大写、缩进一个 indent", () => {
    const d = planBlock(block({ id: "d", characterIds: ["jane"], content: "x" }), null, ctx);
    expect(slotsOf(d).find((s) => s.slot.id === "content")!.slot.style.align).toBe("left");
    const l = planBlock(block({ id: "l", characterIds: ["jane"], lyric: true, content: "ever the lady" }), null, ctx);
    const lyric = slotsOf(l).find((s) => s.slot.id === "content")!;
    expect(lyric.slot.style.case).toBe("upper");
    expect(lyric.slot.indent?.left).toBe(48);
  });

  it("舞台指示：括号内、左右各三个 indent；估算按缩进后的宽度换行", () => {
    const item = planBlock(block({ id: "s", type: "stage", content: "Enter JENNIFER, left." }), null, ctx);
    const c = slotsOf(item)[0];
    expect(c.text).toBe("(Enter JENNIFER, left.)");
    // 作者自己写了括号的不再套一层
    const wrapped = planBlock(block({ id: "sw", type: "stage", content: "（两人对视。）" }), null, ctx);
    expect(slotsOf(wrapped)[0].text).toBe("（两人对视。）");
    expect(c.slot.indent).toEqual({ left: 144, right: 144 });
    const upl = Math.floor((CONTENT_W - 288) / 16); // 22 个全角单位；半角括号各算 0.5
    const long = planBlock(block({ id: "s2", type: "stage", content: "中".repeat(upl - 1) }), null, ctx); // 21 + 括号 1 = 22，正好一行
    expect(H(long)).toBe(26);
    const longer = planBlock(block({ id: "s3", type: "stage", content: "中".repeat(upl) }), null, ctx); // 23 > 22，两行
    expect(H(longer)).toBe(52);
  });
});

describe("规则", () => {
  const a = block({ id: "a", characterIds: ["john"], content: "One." });
  const b = block({ id: "b", characterIds: ["john"], content: "Two." });
  const c = block({ id: "c", characterIds: ["jane"], content: "Three." });

  it("连续同角色省名（含同行的简短提示）；说话人切换前空一行", () => {
    const second = planBlock({ ...b, stageComment: "beat" }, a, ctx);
    expect(slotsOf(second).map((s) => s.slot.id)).toEqual(["content"]);
    expect(second.gapBefore).toBe(0);
    const third = planBlock(c, b, ctx);
    expect(slotsOf(third).map((s) => s.slot.id)).toEqual(["character", "content"]);
    expect(third.gapBefore).toBe(26);
  });

  it("页首续说：省掉的角色名补回并加 (Cont.)；本来就显示名字的页首块不加", () => {
    const second = planBlock(b, a, ctx);
    expect(slotsOf(second, "pageTop").map((s) => s.slot.id)).toEqual(["character", "content"]);
    expect(second.pageTop.suffix.character).toBe(" (Cont.)");
    expect(H(second, "pageTop")).toBe(52);
    const first = planBlock(a, null, ctx);
    expect(first.pageTop.suffix.character).toBeUndefined();
  });

  it("每场另起页：场次标题带 breakBefore，分页器在其前翻页；标题为 ACT I / Scene 1 两行", () => {
    const blocks: Block[] = [
      { ...block({ id: "m1", type: "chapter_marker", sceneId: null }), markerMeta: {} },
      { ...block({ id: "m2", type: "scene_marker", sceneId: null }), markerMeta: {} },
      block({ id: "x1", characterIds: ["john"], content: "A", sceneId: "sc0-1" }),
      { ...block({ id: "m3", type: "scene_marker", sceneId: null }), markerMeta: {} },
      block({ id: "x2", characterIds: ["jane"], content: "B", sceneId: "sc0-2" }),
    ];
    const items = planScript(blocks, ctx, { headingOnlyIfSceneKnown: true });
    const headings = items.filter((i): i is Extract<LayoutItem, { kind: "sceneHeading" }> => i.kind === "sceneHeading");
    expect(headings).toHaveLength(2);
    expect(headings.every((h) => h.breakBefore)).toBe(true);
    expect(headings[0].slots.map((s) => s.text)).toEqual(["ACT I", "Scene 1"]);
    expect(headings[1].slots.map((s) => s.text)).toEqual(["ACT I", "Scene 2"]);
    const result = paginate(items, { contentHeight: 900, countGapBefore: true, heightOf: (i, v) => estimateItemHeight(i, v, CONTENT_W, T.estimate) });
    expect(result.pages.map((p) => p.pageNum)).toEqual([1, 2]);
    expect(result.pageMap).toEqual({ x1: 1, x2: 2 });
    expect(result.pages[1].scene?.id).toBe("sc0-2");
  });
});

describe("页眉页脚", () => {
  it("页眉 幕 – 场 – 页 右上；无页脚；不出目录", () => {
    expect(T.page.header.align).toBe("right");
    expect(T.page.toc.enabled).toBe(false);
    const ctxBand = { pageNum: 51, sceneLabel: "1-1", actRoman: "II", sceneLocal: "1", sceneNumber: "1-1", productionName: "" };
    expect(pageBandText(T.page.header, ctxBand)).toBe("II – 1 – 51");
    expect(pageBandText(T.page.footer, ctxBand)).toBe("");
    // 只有幕没有场（章节标记下直接写正文）→ 丢掉空字段连同它前面的分隔：「II – 51」
    expect(pageBandText(T.page.header, { ...ctxBand, sceneLocal: "" })).toBe("II – 51");
    // 幕场都没有 → 只剩页码；字段全空 → 整条不出
    expect(pageBandText(T.page.header, { ...ctxBand, actRoman: "", sceneLocal: "" })).toBe("51");
    expect(pageBandText(T.page.header, { ...ctxBand, actRoman: "", sceneLocal: "", pageNum: null })).toBe("");
  });

  it("legacy 页带复现今天的页眉页脚文字", () => {
    const L = templateById("legacy-center@1");
    const ctxBand = { pageNum: 3, sceneLabel: "0-1", actRoman: "I", sceneLocal: "1", sceneNumber: "0-1", productionName: "" };
    expect(pageBandText(L.page.header, ctxBand)).toBe("0-1");
    expect(pageBandText(L.page.footer, ctxBand)).toBe("— 3 —");
    expect(pageBandText(L.page.footer, { ...ctxBand, pageNum: null })).toBe("");
  });
});
