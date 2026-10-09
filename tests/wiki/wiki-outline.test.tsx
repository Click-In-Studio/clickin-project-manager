// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WikiOutline from "@/components/wiki/WikiOutline";
import { activeWikiOutlineId, extractWikiOutline } from "@/lib/wiki/outline-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("云文档目录提取", () => {
  it("只提取 H1/H2/H3，保留层级并忽略代码围栏", () => {
    const items = extractWikiOutline([
      "# 总览",
      "## **排练** [计划](https://example.com)",
      "```md",
      "# 不是目录",
      "```",
      "### 细节",
      "#### 不收录",
    ].join("\n"));

    expect(items.map(({ id, level, text }) => ({ id, level, text }))).toEqual([
      { id: "doc-heading-总览", level: 1, text: "总览" },
      { id: "doc-heading-排练-计划", level: 2, text: "排练 计划" },
      { id: "doc-heading-细节", level: 3, text: "细节" },
    ]);
  });

  it("为重复标题生成稳定且唯一的锚点", () => {
    const items = extractWikiOutline("# 设计\n## 设计\n### 设计-2\n### 设计\n# !!!");
    expect(items.map(item => item.id)).toEqual([
      "doc-heading-设计",
      "doc-heading-设计-2",
      "doc-heading-设计-2-2",
      "doc-heading-设计-3",
      "doc-heading-section",
    ]);
    expect(new Set(items.map(item => item.id)).size).toBe(items.length);
  });

  it("长代码围栏不能被较短围栏提前关闭", () => {
    const items = extractWikiOutline([
      "````md",
      "```",
      "# 仍在代码中",
      "````",
      "# 正文标题",
    ].join("\n"));
    expect(items.map(item => item.text)).toEqual(["正文标题"]);
  });

  it("按阅读线高亮最近经过的标题", () => {
    expect(activeWikiOutlineId([
      { id: "a", top: -300 },
      { id: "b", top: 80 },
      { id: "c", top: 260 },
    ])).toBe("b");
    expect(activeWikiOutlineId([{ id: "a", top: 300 }])).toBe("a");
  });
});

describe("云文档目录交互", () => {
  let host: HTMLDivElement;
  let content: HTMLDivElement;
  let root: Root;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    host = document.createElement("div");
    content = document.createElement("div");
    host.append(content);
    document.body.append(host);
    root = createRoot(host.appendChild(document.createElement("div")));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    scrollIntoView.mockReset();
  });

  it("点击目录滚到对应标题，标题改名后当地立即更新", () => {
    content.innerHTML = "<h1>旧标题</h1><h2>细节</h2>";
    const contentRef = createRef<HTMLElement>();
    contentRef.current = content;
    const first = extractWikiOutline("# 旧标题\n## 细节");
    act(() => root.render(<WikiOutline items={first} contentRef={contentRef} />));

    expect(content.querySelector("h1")?.id).toBe("doc-heading-旧标题");
    const outlineNav = host.querySelector<HTMLElement>('nav[aria-label="当前文档目录"]')!;
    act(() => outlineNav.querySelector<HTMLButtonElement>("button")!.click());
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "start" });

    content.innerHTML = "<h1>新标题</h1><h2>细节</h2>";
    const next = extractWikiOutline("# 新标题\n## 细节");
    act(() => root.render(<WikiOutline items={next} contentRef={contentRef} />));
    expect(outlineNav.textContent).toContain("新标题");
    expect(content.querySelector("h1")?.id).toBe("doc-heading-新标题");
  });

  it("源码模式点击目录会选中带格式的完整标题源码", () => {
    const source = document.createElement("textarea");
    source.dataset.wikiSourceEditor = "";
    source.value = "开头\n## **排练** [计划](https://example.com) ##\n正文";
    const unsavedValue = source.value;
    content.append(source);
    const contentRef = createRef<HTMLElement>();
    contentRef.current = content;
    const items = extractWikiOutline(source.value);
    act(() => root.render(<WikiOutline items={items} contentRef={contentRef} />));

    const outlineNav = host.querySelector<HTMLElement>('nav[aria-label="当前文档目录"]')!;
    act(() => outlineNav.querySelector<HTMLButtonElement>("button")!.click());
    expect(source.value).toBe(unsavedValue);
    expect(source.selectionStart).toBe(items[0].offset);
    expect(source.selectionEnd).toBe(items[0].endOffset);
    expect(source.value.slice(source.selectionStart, source.selectionEnd)).toBe("**排练** [计划](https://example.com)");
  });

  it("无标题展示提示，长文档完整保留长标题与层级", () => {
    const contentRef = createRef<HTMLElement>();
    contentRef.current = content;
    act(() => root.render(<WikiOutline items={[]} contentRef={contentRef} />));
    expect(host.querySelector('nav')?.textContent).toContain("添加一级、二级或三级标题");
    const longTitle = "很长的标题".repeat(30);
    const items = extractWikiOutline(Array.from({ length: 100 }, (_, index) => `### ${index} ${longTitle}`).join("\n"));
    act(() => root.render(<WikiOutline items={items} contentRef={contentRef} />));
    const buttons = host.querySelectorAll<HTMLButtonElement>('nav button');
    expect(buttons).toHaveLength(100);
    expect(buttons[99].textContent?.trim()).toBe(`99 ${longTitle}`);
    expect(buttons[99].title).toBe(`99 ${longTitle}`);
  });

  it("目录跳转保持展开，Escape 收起并把焦点交还入口", () => {
    content.innerHTML = "<h1>总览</h1>";
    const contentRef = createRef<HTMLElement>();
    contentRef.current = content;
    act(() => root.render(<WikiOutline items={extractWikiOutline("# 总览")} contentRef={contentRef} />));
    const entry = host.querySelector<HTMLButtonElement>('button[aria-label="展开目录"]')!;
    const panel = host.querySelector<HTMLElement>('aside')!;
    expect(panel.hidden).toBe(true);
    act(() => entry.click());
    const heading = panel.querySelector<HTMLButtonElement>('nav button')!;
    act(() => heading.click());
    expect(panel.hidden).toBe(false);
    expect(entry.getAttribute("aria-expanded")).toBe("true");
    act(() => heading.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(entry);
  });

  it("模式切换后的新 DOM 仍绑定重复标题，并只滚动正文容器", async () => {
    host.id = "workspace-scroll";
    const scrollTo = vi.fn();
    host.scrollTo = scrollTo;
    const contentRef = createRef<HTMLElement>();
    contentRef.current = content;
    const items = extractWikiOutline("# 同名\n## 同名");
    act(() => root.render(<WikiOutline items={items} contentRef={contentRef} />));
    await act(async () => { content.innerHTML = "<h1>同名</h1><h2>同名</h2>"; });
    expect(content.querySelector('h2')?.id).toBe(items[1].id);
    act(() => host.querySelector<HTMLButtonElement>('nav button:nth-child(2)')!.click());
    expect(scrollTo).toHaveBeenCalledWith({ top: -24, behavior: "instant" });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
