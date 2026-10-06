import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wiki 标题排版作用域", () => {
  it("只由文档编辑器挂载专属语境 class", () => {
    const wiki = readFileSync("components/wiki/WikiDocClient.tsx", "utf8");
    const smartTextarea = readFileSync("components/editor/SmartTextarea.tsx", "utf8");

    expect(wiki).toContain('className="wiki-markdown-editor"');
    expect(smartTextarea).not.toContain("wiki-markdown-editor");
    expect(smartTextarea).toMatch(/trailingNode:\s*\{\s*notAfter:\s*\["heading"\]\s*\}/);
  });

  it("H1/H2/H3 的紧凑间距都限定在 wiki 语境，不新增全局 ProseMirror 标题规则", () => {
    const css = readFileSync("app/globals.css", "utf8");

    for (const level of [1, 2, 3]) {
      expect(css).toMatch(new RegExp(`\\.wiki-markdown-editor \\.smart-textarea-content h${level} \\{`));
    }
    expect(css).not.toMatch(/(?:^|\n)\.ProseMirror\s+h[123]\b/);
  });
});
