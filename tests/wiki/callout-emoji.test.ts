// @vitest-environment jsdom
// 高亮块图标选择器（#525 图标一半）：数据表自洽、搜索三路、最近使用容错、
// 点击命中几何，以及 mock 遮不住的接线（SmartTextarea 挂面板、BlockMenu 发事件）。
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import {
  CALLOUT_EMOJI_GROUPS, CALLOUT_EMOJI_PICKER_EVENT, CALLOUT_ICON_ZONE,
  RECENT_EMOJI_KEY, RECENT_EMOJI_MAX,
  calloutIconHit, findCalloutEmoji, pushRecentEmoji, readRecentEmoji, searchCalloutEmoji,
} from "@/lib/editor/callout-emoji";

describe("数据表", () => {
  it("每组非空、每项有名字、全表 emoji 不重复", () => {
    const seen = new Set<string>();
    for (const g of CALLOUT_EMOJI_GROUPS) {
      expect(g.items.length).toBeGreaterThan(0);
      for (const i of g.items) {
        expect(i.name.length).toBeGreaterThan(0);
        expect(seen.has(i.emoji), `重复：${i.emoji}`).toBe(false);
        seen.add(i.emoji);
      }
    }
  });
  it("默认图标 💡 在表里（新建高亮块的默认值要能回查到名字）", () => {
    expect(findCalloutEmoji("💡")?.name).toBe("灵感");
    expect(findCalloutEmoji("🦄")).toBeNull();
  });
});

describe("搜索", () => {
  it("空查询返回 null——面板按分组展示", () => {
    expect(searchCalloutEmoji("")).toBeNull();
    expect(searchCalloutEmoji("   ")).toBeNull();
  });
  it("中文名原文", () => {
    expect(searchCalloutEmoji("警告")!.map(i => i.emoji)).toContain("⚠️");
  });
  it("拼音全拼与首字母（与 / 指令、@ 提及同一套 pinyin-pro）", () => {
    expect(searchCalloutEmoji("jinji")!.map(i => i.emoji)).toContain("🔥");
    expect(searchCalloutEmoji("jj")!.map(i => i.emoji)).toContain("🔥");
  });
  it("英文关键词，大小写不敏感", () => {
    expect(searchCalloutEmoji("Warning")!.map(i => i.emoji)).toContain("⚠️");
  });
  it("无命中给空数组，不给 null", () => {
    expect(searchCalloutEmoji("zzzzqqq")).toEqual([]);
  });
});

describe("最近使用（localStorage，纯便利）", () => {
  beforeEach(() => { localStorage.clear(); });
  it("新用的排最前、去重、封顶", () => {
    for (let i = 0; i < RECENT_EMOJI_MAX + 3; i++) pushRecentEmoji(String.fromCodePoint(0x1f600 + i));
    const list = readRecentEmoji();
    expect(list).toHaveLength(RECENT_EMOJI_MAX);
    pushRecentEmoji("🔥"); pushRecentEmoji("💡"); pushRecentEmoji("🔥");
    const after = readRecentEmoji();
    expect(after.slice(0, 2)).toEqual(["🔥", "💡"]);
    expect(after.filter(x => x === "🔥")).toHaveLength(1);
  });
  it("存的东西坏了 / 不是数组：当没有，不抛", () => {
    localStorage.setItem(RECENT_EMOJI_KEY, "{not json");
    expect(readRecentEmoji()).toEqual([]);
    localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify({ a: 1 }));
    expect(readRecentEmoji()).toEqual([]);
    localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(["🔥", 3, "", null]));
    expect(readRecentEmoji()).toEqual(["🔥"]);
  });
  it("localStorage 访问抛（隐私窗口）：读空、写不抛", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    try {
      expect(readRecentEmoji()).toEqual([]);
      expect(() => pushRecentEmoji("🔥")).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "localStorage", original);
    }
  });
});

describe("点击命中（图标是 ::before，按左上角几何判）", () => {
  const rect = { left: 100, top: 200 };
  it("左上 40×40 内命中，边界外不命中", () => {
    expect(calloutIconHit(rect, 112, 215)).toBe(true);
    expect(calloutIconHit(rect, 100 + CALLOUT_ICON_ZONE.width, 215)).toBe(false);
    expect(calloutIconHit(rect, 112, 200 + CALLOUT_ICON_ZONE.height)).toBe(false);
    expect(calloutIconHit(rect, 99, 215)).toBe(false);
  });
  it("命中区与 CSS 的 padding-left 对得上（改一边要改另一边）", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const m = /\.wiki-callout \{[^}]*padding:\s*\d+px \d+px \d+px (\d+)px/.exec(css);
    expect(m, ".wiki-callout 的四值 padding 没找到").not.toBeNull();
    expect(Number(m![1])).toBe(CALLOUT_ICON_ZONE.width);
  });
});

describe("接线（mock 遮不住的那一层）", () => {
  it("SmartTextarea 在 markdown 编辑面挂 CalloutEmojiPicker", () => {
    const src = readFileSync("components/editor/SmartTextarea.tsx", "utf8");
    expect(src).toMatch(/markdown && !readOnly && <CalloutEmojiPicker editor=\{editor\} \/>/);
  });
  it("BlockMenu「换图标」派发的事件名与面板监听的是同一个常量", () => {
    const menu = readFileSync("components/editor/BlockMenu.tsx", "utf8");
    const picker = readFileSync("components/editor/CalloutEmojiPicker.tsx", "utf8");
    expect(menu).toContain("new CustomEvent(CALLOUT_EMOJI_PICKER_EVENT");
    expect(picker).toContain("addEventListener(CALLOUT_EMOJI_PICKER_EVENT");
    expect(CALLOUT_EMOJI_PICKER_EVENT).toMatch(/^clickin:/);
  });
});
