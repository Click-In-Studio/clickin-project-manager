// @vitest-environment jsdom
// 分栏方言（:::cols … --- … :::）四面测试：DOM 提升、mdast 渲染变换、
// 编辑器真实 roundtrip（保真锁纪律：canonical 形态逐字复原）、飞书 grid
// 经 docx/record 重组。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { Column, ColumnGroup, promoteColumnFences, parseColsRatios } from "@/lib/tiptap-columns";
import { transformColumns } from "@/lib/remark-columns";
import { transformFeishuHtml } from "@/lib/feishu-paste";

describe("parseColsRatios", () => {
  it("合法/非法参数", () => {
    expect(parseColsRatios("46,54")).toEqual([46, 54]);
    expect(parseColsRatios("33, 33, 34")).toEqual([33, 33, 34]);
    expect(parseColsRatios("abc")).toBeNull();
    expect(parseColsRatios("")).toBeNull();
    expect(parseColsRatios("50")).toBeNull(); // 单值不成组
  });
});

describe("promoteColumnFences（markdown 解析侧 DOM 提升）", () => {
  function run(html: string): string {
    const root = document.createElement("div");
    root.innerHTML = html;
    promoteColumnFences(root);
    return root.innerHTML;
  }

  it("canonical 两栏（hr 切栏）提升为 data-cols/data-col", () => {
    const out = run("<p>:::cols</p><p>左</p><hr><p>右</p><p>:::</p>");
    expect(out).toContain('data-cols=""');
    expect(out.match(/data-col=""/g)).toHaveLength(2);
    expect(out).toContain("<p>左</p>");
    expect(out).toContain("<p>右</p>");
    expect(out).not.toContain(":::");
  });

  it("宽度参数落到 data-ratio", () => {
    const out = run("<p>:::cols 46,54</p><p>左</p><hr><p>右</p><p>:::</p>");
    expect(out).toContain('data-ratio="46"');
    expect(out).toContain('data-ratio="54"');
  });

  it("连续两组分栏各自独立", () => {
    const out = run("<p>:::cols</p><p>A</p><hr><p>B</p><p>:::</p><p>:::cols</p><p>C</p><hr><p>D</p><p>:::</p>");
    expect(out.match(/data-cols=""/g)).toHaveLength(2);
  });

  it("不成对 fence / 单栏（无 hr）原样保留，不吃内容", () => {
    const noClose = run("<p>:::cols</p><p>孤儿</p>");
    expect(noClose).toContain(":::cols");
    expect(noClose).toContain("孤儿");
    const single = run("<p>:::cols</p><p>只有一栏</p><p>:::</p>");
    expect(single).toContain("只有一栏");
    expect(single).not.toContain("data-cols");
  });
});

describe("transformColumns（渲染侧 mdast 变换）", () => {
  const p = (t: string) => ({ type: "paragraph", children: [{ type: "text", value: t }] });
  const hr = () => ({ type: "thematicBreak" });

  it("canonical 区间变换为 wikiCols/wikiCol", () => {
    const root = { type: "root", children: [p(":::cols 46,54"), p("左"), hr(), p("右"), p(":::")] };
    transformColumns(root);
    expect(root.children).toHaveLength(1);
    const g = root.children[0] as { type: string; children: { type: string; data: { hProperties: Record<string, unknown> } }[] };
    expect(g.type).toBe("wikiCols");
    expect(g.children).toHaveLength(2);
    expect(g.children[0].data.hProperties.style).toBe("flex:0 1 46%");
  });

  it("不成对 fence 原样保留", () => {
    const root = { type: "root", children: [p(":::cols"), p("孤儿")] };
    transformColumns(root);
    expect(root.children).toHaveLength(2);
    expect(root.children[0].type).toBe("paragraph");
  });
});

describe("editor roundtrip（保真锁纪律）", () => {
  function roundtrip(md: string): string {
    const editor = new Editor({
      extensions: [StarterKit, Markdown.configure({ breaks: true }), Column, ColumnGroup],
      content: md,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (editor.storage as any).markdown.getMarkdown() as string;
    editor.destroy();
    return out;
  }

  it("两栏 canonical 逐字复原", () => {
    const md = ":::cols\n\n左栏内容\n\n---\n\n右栏内容\n\n:::";
    expect(roundtrip(md)).toBe(md);
  });

  it("带宽度参数逐字复原", () => {
    const md = ":::cols 46,54\n\n左\n\n---\n\n右\n\n:::";
    expect(roundtrip(md)).toBe(md);
  });

  it("三栏 + 前后正文共存", () => {
    const md = "前文\n\n:::cols\n\n甲\n\n---\n\n乙\n\n---\n\n丙\n\n:::\n\n后文";
    expect(roundtrip(md)).toBe(md);
  });

  it("分栏外的普通水平线不受影响", () => {
    const md = "上文\n\n---\n\n下文";
    expect(roundtrip(md)).toBe(md);
  });
});

describe("飞书 grid 经 docx/record 重组", () => {
  const html = `<div data-lark-html-role="root">` +
    `<div data-type="grid" class=" old-record-id-GRID1"></div>` +
    `<p class="ace-line old-record-id-KID_A">左栏文字</p>` +
    `<p class="ace-line old-record-id-KID_B">右栏文字</p>` +
    `</div>`;
  const record = JSON.stringify({
    recordMap: {
      GRID1: { snapshot: { type: "grid", children: ["COL1", "COL2"] } },
      COL1: { snapshot: { type: "grid_column", children: ["KID_A"], width_ratio: 0.4586 } },
      COL2: { snapshot: { type: "grid_column", children: ["KID_B"], width_ratio: 0.5414 } },
    },
  });

  it("拍平块按 record 归栏，带宽度比", () => {
    const out = transformFeishuHtml(html, { record });
    expect(out).toContain('data-cols=""');
    expect(out).toContain('data-ratio="46"');
    expect(out).toContain('data-ratio="54"');
    // 内容进栏且不再散落在外
    expect(out).toMatch(/data-col[^>]*>.*左栏文字/);
  });

  it("缺块 → 整组放弃重组，内容保持拍平零丢失", () => {
    const brokenRecord = JSON.stringify({
      recordMap: {
        GRID1: { snapshot: { type: "grid", children: ["COL1", "COL2"] } },
        COL1: { snapshot: { type: "grid_column", children: ["KID_A", "KID_MISSING"] } },
        COL2: { snapshot: { type: "grid_column", children: ["KID_B"] } },
      },
    });
    const out = transformFeishuHtml(html, { record: brokenRecord });
    expect(out).not.toContain("data-cols");
    expect(out).toContain("左栏文字");
    expect(out).toContain("右栏文字");
  });

  it("id 互为前缀不串块（token 精确匹配，非子串）", () => {
    // KID_A2 元素排在 KID_A 之前——子串匹配会把 KID_A 错配到 KID_A2 的块上
    const prefixHtml = `<div data-lark-html-role="root">` +
      `<div data-type="grid" class=" old-record-id-GRID1"></div>` +
      `<p class="ace-line old-record-id-KID_A2">乙栏文字</p>` +
      `<p class="ace-line old-record-id-KID_A">甲栏文字</p>` +
      `</div>`;
    const rec = JSON.stringify({
      recordMap: {
        GRID1: { snapshot: { type: "grid", children: ["COL1", "COL2"] } },
        COL1: { snapshot: { type: "grid_column", children: ["KID_A"] } },
        COL2: { snapshot: { type: "grid_column", children: ["KID_A2"] } },
      },
    });
    const out = transformFeishuHtml(prefixHtml, { record: rec });
    expect(out).toContain("data-cols");
    // 第一栏必须是甲（KID_A），第二栏是乙（KID_A2）
    expect(out.indexOf("甲栏文字")).toBeLessThan(out.indexOf("乙栏文字"));
  });

  it("完全无结构信息（无剪贴板 record、无内嵌 span）→ 不重组不报错", () => {
    const out = transformFeishuHtml(html);
    expect(out).not.toContain("data-cols");
    expect(out).toContain("左栏文字");
  });

  it("Safari 路径：剪贴板拿不到 record，仅凭 HTML 内嵌 span 也能重组", () => {
    // WKWebView getData 不暴露自定义类型（docx/record 恒空）；飞书把同一份
    // recordMap 嵌在 span[data-lark-record-data]，text/html 恒可得
    const embedded = record.replace(/"/g, "&quot;");
    const htmlWithSpan = html.replace(
      "</div>",
      `<span data-lark-record-data="${embedded}"></span></div>`,
    );
    const out = transformFeishuHtml(htmlWithSpan); // 不传 record！
    expect(out).toContain('data-cols=""');
    expect(out).toContain('data-ratio="46"');
    expect(out).toMatch(/data-col[^>]*>.*左栏文字/);
    // 元数据 span 读完即删，不残留进内容
    expect(out).not.toContain("data-lark-record-data");
  });

  it("两源合并：剪贴板与内嵌 span 各持一半记录也能拼出完整结构", () => {
    const full = JSON.parse(record) as { recordMap: Record<string, unknown> };
    const half1: Record<string, unknown> = {}, half2: Record<string, unknown> = {};
    Object.entries(full.recordMap).forEach(([k, v], i) => { (i % 2 ? half1 : half2)[k] = v; });
    const spanJson = JSON.stringify({ recordMap: half2 }).replace(/"/g, "&quot;");
    const htmlWithSpan = html.replace("</div>", `<span data-lark-record-data="${spanJson}"></span></div>`);
    const out = transformFeishuHtml(htmlWithSpan, { record: JSON.stringify({ recordMap: half1 }) });
    expect(out).toContain('data-cols=""');
  });
});
