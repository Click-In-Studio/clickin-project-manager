// @vitest-environment jsdom
// 栏宽拖拽的可测部分。
//
// 拖动手势本身吃 DOM 矩形（jsdom 没布局），测不了；但**落进正文的是什么**是
// 纯函数——而分栏宽度是方言的主参数位（`:::cols 46,54`），写错就是正文错。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { Column, ColumnGroup } from "@/lib/tiptap-columns";
import {
  ColumnEditing, insertColumnAt, setColumnRatios, normalizeRatios,
} from "@/lib/tiptap-column-editing";
import { ColumnResize } from "@/lib/tiptap-column-resize";

function makeEditor(content: string) {
  return new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ transformCopiedText: true, breaks: true }),
      Column, ColumnGroup, ColumnEditing,
    ],
    content,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const md = (e: Editor) => (e.storage as any).markdown.getMarkdown() as string;

const TWO = ":::cols\n\n左\n\n---\n\n右\n\n:::";

describe("分割线的 DOM 结构与插入下标", () => {
  // jsdom 没有布局，但 DOM 结构和事件是真的——而这次踩的坑恰恰是结构问题：
  // 两端的 ⊕ 原先挂在首/末栏里，末栏于是同时背着「左侧分割线」和「右端 ⊕」
  // 两个 widget，那一栏就坏了（竖线点不到、⊕ 插错位置、右端 ⊕ 不出现）。
  function mount(content: string) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const editor = new Editor({
      element: el,
      extensions: [
        StarterKit, Markdown.configure({ breaks: true }),
        Column, ColumnGroup, ColumnEditing, ColumnResize,
      ],
      content,
    });
    return { editor, el, cleanup: () => { editor.destroy(); el.remove(); } };
  }

  const SRC: Record<number, string> = {
    2: ":::cols\n\n一\n\n---\n\n二\n\n:::",
    3: ":::cols\n\n一\n\n---\n\n二\n\n---\n\n三\n\n:::",
    4: ":::cols\n\n一\n\n---\n\n二\n\n---\n\n三\n\n---\n\n四\n\n:::",
  };

  it.each([2, 3, 4])("%i 栏：n+1 个操作件，两端的挂在组上、可拖的挂在各自栏里", (n) => {
    const { el, cleanup } = mount(SRC[n]);
    const all = [...el.querySelectorAll(".wiki-col-resizer")];
    expect(all).toHaveLength(n + 1);

    const addOnly = all.filter(r => r.classList.contains("is-add-only"));
    expect(addOnly).toHaveLength(2);
    // 两端的必须挂在组上——挂进栏里就会和该栏的分割线叠在一起
    for (const r of addOnly) {
      expect((r.parentElement as HTMLElement).classList.contains("wiki-cols")).toBe(true);
    }
    expect(addOnly.filter(r => r.classList.contains("is-right"))).toHaveLength(1);

    // 每一栏至多一个 widget
    for (const col of el.querySelectorAll(".wiki-col")) {
      expect(col.querySelectorAll(":scope > .wiki-col-resizer").length).toBeLessThanOrEqual(1);
    }
    cleanup();
  });

  it.each([2, 3, 4])("%i 栏：按 DOM 顺序点每个 ⊕，插入下标依次是 0..n", (n) => {
    for (let k = 0; k <= n; k++) {
      const { editor, el, cleanup } = mount(SRC[n]);
      const adds = [...el.querySelectorAll(".wiki-col-resizer-add")] as HTMLElement[];
      expect(adds).toHaveLength(n + 1);
      adds[k].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      const parts = md(editor).split("\n---\n")
        .map(s => s.replace(/:::cols|:::/g, "").trim());
      expect(parts).toHaveLength(n + 1);
      expect(parts[k]).toBe(""); // 新栏是空的，且落在第 k 个位置
      cleanup();
    }
  });

  it("只有中间那些分割线可拖，两端的不可拖（没有邻栏可对分宽度）", () => {
    const { el, cleanup } = mount(SRC[3]);
    const all = [...el.querySelectorAll(".wiki-col-resizer")];
    const draggable = all.filter(r => !r.classList.contains("is-add-only"));
    expect(draggable).toHaveLength(2); // 3 栏两条缝
    // 可拖的才有那条线；两端的只有 ⊕
    for (const r of draggable) expect(r.querySelector(".wiki-col-resizer-line")).not.toBeNull();
    for (const r of all.filter(r => r.classList.contains("is-add-only"))) {
      expect(r.querySelector(".wiki-col-resizer-line")).toBeNull();
    }
    cleanup();
  });
});

describe("normalizeRatios —— 像素宽度 → 整数百分比", () => {
  it("和恒为 100（要落进正文，99 或 101 都会让下次读回来的布局对不上）", () => {
    const cases = [
      [100, 100], [1, 2], [333, 333, 334], [7, 11, 13, 17],
      [500, 1], [1, 1, 1], [123.456, 654.321],
    ];
    for (const w of cases) {
      const r = normalizeRatios(w);
      expect(r).toHaveLength(w.length);
      expect(r.reduce((a, b) => a + b, 0)).toBe(100);
    }
  });

  it("每一栏至少 1%（0% 的栏视觉上消失但结构还在，是最难查的状态）", () => {
    for (const w of [[1000, 1], [1, 1000, 1], [999, 1, 1, 1]]) {
      for (const v of normalizeRatios(w)) expect(v).toBeGreaterThanOrEqual(1);
    }
  });

  it("比例守恒：等宽给等分，2:1 给约 67:33", () => {
    expect(normalizeRatios([50, 50])).toEqual([50, 50]);
    expect(normalizeRatios([200, 100])).toEqual([67, 33]);
    const three = normalizeRatios([100, 100, 100]);
    expect(three.every(v => Math.abs(v - 33.3) < 1.5)).toBe(true);
  });

  it("退化输入不崩：空数组、全零宽", () => {
    expect(normalizeRatios([])).toEqual([]);
    expect(normalizeRatios([0, 0]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(normalizeRatios([0, 0, 0]).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe("setColumnRatios", () => {
  it("写入后序列化成主参数位", () => {
    const e = makeEditor(TWO);
    const tr = e.state.tr;
    expect(setColumnRatios(tr, 0, [40, 60])).toBe(true);
    e.view.dispatch(tr);
    expect(md(e)).toContain(":::cols 40,60");
    e.destroy();
  });

  it("宽度串落地后可逐字往返（保真锁纪律）", () => {
    const e = makeEditor(TWO);
    const tr = e.state.tr;
    setColumnRatios(tr, 0, [30, 70]);
    e.view.dispatch(tr);
    const produced = md(e);
    e.destroy();
    const again = makeEditor(produced);
    expect(md(again)).toBe(produced);
    again.destroy();
  });

  it("数量对不上就拒绝 —— serializer 只在每栏都有 ratio 时才写主参数位，"
    + "写一半等于白写", () => {
    const e = makeEditor(TWO);
    const tr = e.state.tr;
    expect(setColumnRatios(tr, 0, [50])).toBe(false);
    expect(setColumnRatios(tr, 0, [30, 30, 40])).toBe(false);
    expect(tr.docChanged).toBe(false);
    e.destroy();
  });

  it("坐标不是分栏组就拒绝", () => {
    const e = makeEditor("甲");
    const tr = e.state.tr;
    expect(setColumnRatios(tr, 0, [50, 50])).toBe(false);
    e.destroy();
  });

  it("改宽度不动内容（setNodeMarkup 而不是重建整组）", () => {
    const e = makeEditor(":::cols\n\n左\n\n---\n\n右\n\n:::");
    const tr = e.state.tr;
    setColumnRatios(tr, 0, [25, 75]);
    e.view.dispatch(tr);
    const out = md(e);
    expect(out).toContain("左");
    expect(out).toContain("右");
    e.destroy();
  });
});

describe("insertColumnAt —— 分割线顶端的 ⊕", () => {
  it("插到指定下标，不是只能追加到末尾", () => {
    const e = makeEditor(":::cols\n\n一\n\n---\n\n二\n\n:::");
    const tr = e.state.tr;
    expect(insertColumnAt(tr, 0, 1)).toBe(true);
    e.view.dispatch(tr);
    const parts = md(e).split("\n---\n");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("一");
    expect(parts[2]).toContain("二");
    e.destroy();
  });

  it("新栏是空栏，且**不会**被自动回收（空栏是合法状态）", () => {
    const e = makeEditor(TWO);
    const tr = e.state.tr;
    insertColumnAt(tr, 0, 1);
    e.view.dispatch(tr);
    expect(e.state.doc.child(0).childCount).toBe(3);
    // 再跑一个事务，确认 appendTransaction 也不会把它收掉。
    // 落点取第一栏的段落内部（pos 3）——组内栏与栏之间（pos 1）不是合法的
    // 文本位置，PM 会为了塞下这段文字**再包一栏**出来
    e.view.dispatch(e.state.tr.insertText("x", 3));
    expect(e.state.doc.child(0).childCount).toBe(3);
    expect(md(e)).toContain("x左"); // pos 3 是第一栏段落内容的起点，插在「左」之前
    e.destroy();
  });

  it("插栏后清空所有 ratio —— 旧宽度串是按旧栏数配的", () => {
    const e = makeEditor(":::cols 40,60\n\n左\n\n---\n\n右\n\n:::");
    expect(md(e)).toContain(":::cols 40,60");
    const tr = e.state.tr;
    insertColumnAt(tr, 0, 1);
    e.view.dispatch(tr);
    expect(md(e)).not.toMatch(/:::cols\s+\d/);
    e.destroy();
  });

  // 组最外两端的 ⊕ 就落在这两个下标上（左端 0、右端 childCount）——
  // 拖动在那里没有意义（没有邻栏可对分宽度），但加栏必须能做
  it("插到最左端（index 0）", () => {
    const e = makeEditor(":::cols\n\n一\n\n---\n\n二\n\n:::");
    const tr = e.state.tr;
    expect(insertColumnAt(tr, 0, 0)).toBe(true);
    e.view.dispatch(tr);
    const parts = md(e).split("\n---\n");
    expect(parts).toHaveLength(3);
    expect(parts[0].replace(":::cols", "").trim()).toBe(""); // 新栏是空的
    expect(parts[1]).toContain("一");
    expect(parts[2]).toContain("二");
    e.destroy();
  });

  it("插到最右端（index = 栏数）", () => {
    const e = makeEditor(":::cols\n\n一\n\n---\n\n二\n\n:::");
    const group = e.state.doc.child(0);
    const tr = e.state.tr;
    expect(insertColumnAt(tr, 0, group.childCount)).toBe(true);
    e.view.dispatch(tr);
    const parts = md(e).split("\n---\n");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("一");
    expect(parts[1]).toContain("二");
    e.destroy();
  });

  it("下标越界被夹住", () => {
    const e = makeEditor(TWO);
    const tr = e.state.tr;
    expect(insertColumnAt(tr, 0, 99)).toBe(true);
    e.view.dispatch(tr);
    expect(e.state.doc.child(0).childCount).toBe(3);
    e.destroy();
  });

  it("坐标不是分栏组就拒绝", () => {
    const e = makeEditor("甲");
    const tr = e.state.tr;
    expect(insertColumnAt(tr, 0, 0)).toBe(false);
    e.destroy();
  });
});
