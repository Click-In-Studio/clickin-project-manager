// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";
import StreamingWikiMarkdown from "@/components/wiki/StreamingWikiMarkdown";
import MarkdownCodeBlock from "@/components/wiki/MarkdownCodeBlock";

const highlight = vi.hoisted(() => vi.fn(async (code: string) => `<pre data-highlighted><code>${code.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</code></pre>`));
vi.mock("shiki", () => ({ codeToHtml: highlight }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));

let container: HTMLDivElement, root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  highlight.mockClear();
  fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    const mentions = JSON.parse(String(options?.body)).mentions as Array<{ id: string }>;
    return { ok: true, json: async () => ({ labels: mentions.map(m => `真实名称 ${m.id}`), urls: mentions.map(m => `/target/${m.id}`) }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function render(element: React.ReactNode) {
  await act(async () => { root.render(element); await new Promise(resolve => setTimeout(resolve, 0)); });
}
function signature() {
  return [...container.querySelectorAll("h1,h2,p,ul,ol,li,blockquote,table,tr,td,th,a,pre,code,strong,em,div.wiki-cols,div.wiki-col,div.wiki-callout")]
    .map(node => [node.tagName, node.textContent, node.getAttribute("href"), (node as HTMLElement).style.cssText,
      node.getAttribute("colspan"), node.matches("div.wiki-cols,div.wiki-col,div.wiki-callout") ? node.className : null]);
}

describe("分块与同一份 WikiMarkdown 的实际渲染一致", () => {
  const samples = [
    "## 排练安排\n\n正文**加粗**与 ~~删除~~。\n\n- 第一场\n  - 灯光\n- 第二场\n\n> [!💡]\n> 提示",
    "| 场次 | 状态 |\n| :--- | ---: |\n| 第一场 | **完成** |\n| 第二场 | a\\|b |\n\n## 后续\n\n正文",
    ":::cols 40,60\n\n左侧\n\n---\n\n右侧\n\n:::\n\n后续",
    ":::table\n\n:::row\n\n:::cell header=true\n\n第一格\n\n:::endcell\n\n:::cell\n\n**第二格**\n\n:::endcell\n\n:::endrow\n\n:::endtable\n\n后续",
    '<table><tr><td>第一格</td><td><strong>第二格</strong></td></tr></table>\n\n后续',
    '<span style="background-color:yellow"><span style="color:red">**重点**</span></span> 与 <u>下划线</u>\n\n- [x] 已完成',
    "先看 [来源][ref]。\n\n后续\n\n[ref]: https://example.com",
    "场次 [#](/__cm__/scene/scene1)\n\n文档 [模型伪造的名字](/__cm__/wiki/wiki1)",
  ];
  for (const content of samples) it(content.slice(0, 30), async () => {
    await render(<WikiMarkdown content={content} productionId="prod" />);
    const expected = signature(), text = container.textContent;
    await render(<StreamingWikiMarkdown key="stream" content="" productionId="prod" streaming />);
    for (let i = 7; i < content.length; i += 7) await render(<StreamingWikiMarkdown key="stream" content={content.slice(0, i)} productionId="prod" streaming />);
    await render(<StreamingWikiMarkdown key="stream" content={content} productionId="prod" streaming={false} />);
    expect(signature()).toEqual(expected);
    expect(container.textContent).toBe(text);
  });

  it("已经完成的段落和表格行保持同一 DOM；追加新行不会再解析旧引用", async () => {
    const content = "首段。\n\n| 场次 | 状态 |\n| --- | --- |\n| [#](/__cm__/scene/s1) | 完成 |\n";
    await render(<StreamingWikiMarkdown content={content} productionId="prod" streaming />);
    const paragraph = container.querySelector("p"), row = container.querySelector("tbody tr"), requests = fetchMock.mock.calls.length;
    await render(<StreamingWikiMarkdown content={content + "| 第二场 | 待确认"} productionId="prod" streaming />);
    expect(container.querySelector("p")).toBe(paragraph);
    expect(container.querySelector("tbody tr")).toBe(row);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });
});

describe("引用与流式代码", () => {
  it("未闭合引用和代码示例不查询实体；闭合后只采用真实解析名称", async () => {
    await render(<StreamingWikiMarkdown content="引用 [#](/__cm__/wiki/id" productionId="prod" streaming />);
    expect(fetchMock).not.toHaveBeenCalled();
    await render(<StreamingWikiMarkdown content="引用 [假名字](/__cm__/wiki/id)" productionId="prod" streaming />);
    expect(container.textContent).toContain("真实名称 id");
    expect(container.textContent).not.toContain("假名字");
    fetchMock.mockClear();
    await render(<WikiMarkdown content={'```md\n[#](/__cm__/wiki/example)\n[[标题示例]]\n```'} productionId="prod" />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("[[标题示例]]");
  });

  it.each(["#[无权查看]", "#[已删除]"])("引用不可用时不生成跳转地址：%s", async label => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ labels: [label], urls: [null] }) });
    await render(<StreamingWikiMarkdown content="[#](/__cm__/wiki/hidden)" productionId="prod" streaming={false} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toContain("hidden");
    expect(container.textContent).toMatch(/无权查看|已删除/);
  });

  it("正文继续追加时保留在途引用请求，旧制作的迟到结果不会覆盖新语境", async () => {
    let complete!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await render(<WikiMarkdown content="[#](/__cm__/scene/one)" productionId="first" />);
    await render(<WikiMarkdown content="[#](/__cm__/scene/one) 后续" productionId="first" />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await render(<WikiMarkdown content="[#](/__cm__/scene/two)" productionId="second" />);
    await act(async () => complete({ ok: true, json: async () => ({ labels: ["旧制作名称"], urls: ["/old"] }) }));
    expect(container.textContent).toContain("真实名称 two");
    expect(container.textContent).not.toContain("旧制作名称");
  });

  it("生成中的代码按纯文本追加，闭合后才高亮；EOF 未闭合时结束也正常渲染", async () => {
    const open = "````typescript\nconst rareCode = '**保留文字**';\n```";
    await render(<StreamingWikiMarkdown content={open} streaming />);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    expect(highlight).not.toHaveBeenCalled();
    await render(<StreamingWikiMarkdown content={open + "\n````"} streaming />);
    expect(container.querySelector("[data-highlighted]")).not.toBeNull();
    expect(highlight).toHaveBeenCalledTimes(1);
    await render(<StreamingWikiMarkdown content={"```typescript\nconst atEof = 42;"} streaming={false} />);
    expect(container.querySelector("[data-streaming-code]")).toBeNull();
    expect(container.textContent).toContain("const atEof = 42;");
  });

  it("缓存命中必须展示当前代码，不得继续显示上一个 key 的结果（#1048）", async () => {
    await render(<><MarkdownCodeBlock code="const cacheA = 1;" lang="typescript" /><MarkdownCodeBlock code="const cacheB = 2;" lang="typescript" /></>);
    const calls = highlight.mock.calls.length;
    await render(<><MarkdownCodeBlock code="const cacheB = 2;" lang="typescript" /><MarkdownCodeBlock code="const cacheB = 2;" lang="typescript" /></>);
    expect(container.textContent).not.toContain("cacheA");
    expect([...container.querySelectorAll("pre code")].map(node => node.textContent)).toEqual(["const cacheB = 2;", "const cacheB = 2;"]);
    expect(highlight).toHaveBeenCalledTimes(calls);
  });
});
