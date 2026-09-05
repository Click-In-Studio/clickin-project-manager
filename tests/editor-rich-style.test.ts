// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { RichStyle, decodeRichStyleHref, encodeRichStyleHref, updateRichStyle } from "@/lib/tiptap-rich-style";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";

const md = (editor: Editor) => (editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();

describe("rich style markdown dialect", () => {
  it("encodes and decodes underline, font color and background color", () => {
    const href = encodeRichStyleHref({ underline: true, color: "#DC2626", backgroundColor: "#DBEAFE" });
    expect(decodeRichStyleHref(href)).toEqual({ underline: true, color: "#dc2626", backgroundColor: "#dbeafe" });
  });

  it("roundtrips through the real editor", () => {
    const source = "[重点文字](/__rs__/?u=1&fg=%23dc2626&bg=%23dbeafe)";
    const editor = new Editor({ extensions: [StarterKit, Markdown.configure({ breaks: true }), RichStyle], content: source });
    expect(md(editor)).toBe(source);
    editor.destroy();
  });

  it("can remove only one style while preserving the other attributes", () => {
    const editor = new Editor({ extensions: [StarterKit, Markdown.configure({ breaks: true }), RichStyle], content: "abc" });
    editor.commands.selectAll();
    updateRichStyle(editor, { underline: true, color: "#2563eb" });
    updateRichStyle(editor, { underline: false });
    expect(md(editor)).toBe("[abc](/__rs__/?fg=%232563eb)");
    editor.destroy();
  });

  it("restores the style in the read-only markdown renderer", () => {
    const html = renderToStaticMarkup(
      createElement(WikiMarkdown, { content: "[重点文字](/__rs__/?u=1&fg=%23dc2626&bg=%23dbeafe)" }),
    );
    expect(html).toContain("text-decoration:underline");
    expect(html).toContain("color:#dc2626");
    expect(html).toContain("background-color:#dbeafe");
    expect(html).not.toContain("/__rs__/");
  });
});
