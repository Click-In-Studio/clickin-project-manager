import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownStream, openCodeFence } from "@/lib/wiki/markdown-stream";
import StreamingWikiMarkdown from "@/components/wiki/StreamingWikiMarkdown";

describe("流式 Markdown 的结构边界", () => {
  const samples = [
    "## 标题\n\n正文 **加粗**。\n\n- 甲\n\n  - 子项\n\n尾段。",
    ":::cols 40,60\n\n左栏\n\n---\n\n右栏\n\n:::\n\n后续。",
    ":::table\n\n:::row\n\n:::cell\n\n第一格\n\n:::endcell\n\n:::cell\n\n~~~md\n:::endtable\n~~~\n\n:::endcell\n\n:::endrow\n\n:::endtable\n\n后续。",
    "前文\n\n```md\n:::cols\n\n[[示例]]\n```\n\n后文。",
    "\n\n| 场次 | 状态 |\n| --- | --- |\n| 第一场 | 完成 |\n| 第二场 | 待定 |\n\n## 下一段\n\n正文。",
    "| A | B |\n| :--- | ---: |\n| a\\|b | `x` |\n| 末尾转义\\| | b\\|\n\n后续段落",
    "| A | B |\n| --- | ---",
  ];
  for (const sample of samples) it(`逐字追加不丢原文：${sample.slice(0, 25)}`, () => {
    const parser = new MarkdownStream();
    for (let i = 1; i <= sample.length; i++) {
      const source = sample.slice(0, i);
      expect(parser.update(source).map(piece => piece.source).join(""), `第 ${i} 字符`).toBe(source);
    }
  });

  it("未完成容器整体保留，容器内空行不会冻结成独立块", () => {
    const parser = new MarkdownStream();
    const initial = ":::cols 40,60\n\n左边\n\n---\n\n右边";
    expect(parser.update(initial)).toEqual([{ source: initial }]);
    expect(parser.update(initial + "\n\n:::\n\n结束")).toHaveLength(2);
  });

  it("完整段落对象可复用；改写正文时重新解析，引用定义保留全局语境", () => {
    const parser = new MarkdownStream();
    const first = parser.update("首段。\n\n第二段");
    expect(parser.update("首段。\n\n第二段继续")[0]).toBe(first[0]);
    expect(parser.update("改写后的首段")).toEqual([{ source: "改写后的首段" }]);
    const references = "先看 [名字][ref]。\n\n后段\n\n[ref]: https://example.com";
    expect(parser.update(references)).toEqual([{ source: references }]);
  });

  it("普通表格完整行只解析一次；半行可见，下一块不被吞进表格", () => {
    const parser = new MarkdownStream();
    const source = "| A | B |\n| --- | --- |\n| 第一行 | 已确认 |\n";
    const first = parser.update(source)[0].table!;
    const next = parser.update(source + "| 第二行 | 待确认")[0].table!;
    expect(next.rows[0]).toBe(first.rows[0]);
    expect(next.rows[1]).toEqual(["第二行", "待确认"]);
    const final = parser.update(source + "| 第二行 | 待确认\n\n## 后续标题\n\n段落");
    expect(final[0].table!.rows).toEqual([["第一行", "已确认"], ["第二行", "待确认"]]);
    expect(final.slice(1).map(piece => piece.source).join("")).toContain("## 后续标题");
  });

  it("缺格补空、超出表头的格忽略；转义末尾竖线仍是文字", () => {
    const parser = new MarkdownStream();
    const result = parser.update("| A | B |\n| --- | --- |\n| 甲 |\n| 乙 | 丙 | 忽略 |\n| 丁 | 戊\\|")[0].table!;
    expect(result.rows).toEqual([["甲", ""], ["乙", "丙"], ["丁", "戊\\|"]]);
  });

  it("SSR 不读取 window，未闭合代码在生成中为纯文字，结束后按代码渲染", () => {
    expect(typeof window).toBe("undefined");
    const content = "```md\n**不是加粗**\n__attr__=1";
    const pending = renderToStaticMarkup(React.createElement(StreamingWikiMarkdown, { content, streaming: true }));
    expect(pending).toContain("data-streaming-code");
    expect(pending).not.toContain("<pre");
    expect(pending).not.toContain("<strong");
    const ended = renderToStaticMarkup(React.createElement(StreamingWikiMarkdown, { content, streaming: false }));
    expect(ended).toContain("<pre");
    expect(ended).not.toContain("data-streaming-code");
  });

  it("引用块中已经闭合的代码不会继续显示为生成中", () => {
    const content = "> ```md\n> **原文**\n> ```";
    const html = renderToStaticMarkup(React.createElement(StreamingWikiMarkdown, { content, streaming: true }));
    expect(html).toContain("<pre");
    expect(html).not.toContain("data-streaming-code");
  });

  it("围栏按同字符和长度闭合，代码内部短围栏不提前完成", () => {
    expect(openCodeFence("````md\n```\n正文")).toBe(true);
    expect(openCodeFence("~~~md\n```\n正文")).toBe(true);
    expect(openCodeFence("~~~md\n正文\n~~~~")).toBe(false);
    expect(openCodeFence("```md\n正文\n```后续")).toBe(true);
    expect(openCodeFence("    缩进代码")).toBe(false);
  });
});
