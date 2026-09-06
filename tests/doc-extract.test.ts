// #47 docx 薄解析器测试。合成 fixture（照 qlab 先例：测试里手写最小 zip
// writer，真实剧本含用户内容不入库）。覆盖四标本实测钉下的解析纪律：
// - 布尔属性按值判否（w:b val="0" / w:u val="none" 是关——Google Docs 导出件
//   里 val="none" 比真下划线多一个量级，误判即全文假信号）；
// - 非文本对象占位（可见性先于分诊：AI 问不出它看不见的东西）；
// - 脚注一等公民（替换台词常在脚注）；
// - 样式继承链解析（styleId → 显示名 + basedOn 链上的对齐）；
// - 缩进浮点碎片取整（初创剧本常态）。

import { describe, it, expect } from "vitest";
import { bufferByteSource } from "@/lib/asset/byte-source";
import { parseDocx, DocxParseError, type DocxParagraph, type DocxTable } from "@/lib/doc-extract/docx";

// ─── 最小 store-only zip writer（本解析器不校验 crc，置 0 即可）──────────────

function makeZip(files: Array<{ name: string; content: string }>): Buffer {
  const parts: Buffer[] = [];
  const cd: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.content, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0, 6);             // flags
    lh.writeUInt16LE(0, 8);             // method 0 = store
    lh.writeUInt32LE(data.length, 18);  // compressed
    lh.writeUInt32LE(data.length, 22);  // uncompressed
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);            // extra len
    parts.push(lh, name, data);

    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0);
    ce.writeUInt16LE(0, 8);             // flags
    ce.writeUInt16LE(0, 10);            // method
    ce.writeUInt32LE(data.length, 20);
    ce.writeUInt32LE(data.length, 24);
    ce.writeUInt16LE(name.length, 28);
    ce.writeUInt32LE(offset, 42);
    cd.push(ce, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;

function docxOf(documentBody: string, extra?: { styles?: string; footnotes?: string }): Buffer {
  const files = [
    { name: "[Content_Types].xml", content: `${XML_HEAD}<Types/>` },
    { name: "word/document.xml", content: `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentBody}</w:body></w:document>` },
  ];
  if (extra?.styles) files.push({ name: "word/styles.xml", content: `${XML_HEAD}<w:styles xmlns:w="x">${extra.styles}</w:styles>` });
  if (extra?.footnotes) files.push({ name: "word/footnotes.xml", content: `${XML_HEAD}<w:footnotes xmlns:w="x">${extra.footnotes}</w:footnotes>` });
  return makeZip(files);
}

const p = (inner: string) => `<w:p>${inner}</w:p>`;
const r = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;

async function parse(buf: Buffer) {
  return parseDocx(bufferByteSource(buf));
}

// ─── 测试 ────────────────────────────────────────────────────────────────────

describe("docx 结构信号抽取", () => {
  it("段落基础信号：直接对齐、缩进浮点取整、样式名与链上对齐解析", async () => {
    const styles = `
      <w:style w:type="paragraph" w:styleId="Base"><w:name w:val="基底"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>
      <w:style w:type="paragraph" w:styleId="H1"><w:name w:val="场景标题"/><w:basedOn w:val="Base"/></w:style>`;
    const body = [
      p(`<w:pPr><w:pStyle w:val="H1"/></w:pPr>${r("第一场 雨夜")}`),
      p(`<w:pPr><w:jc w:val="right"/></w:pPr>${r("（舞台指示）")}`),
      p(`<w:pPr><w:ind w:left="1203.8327" w:firstLine="0"/></w:pPr>${r("台词一句")}`),
    ].join("");
    const doc = await parse(docxOf(body, { styles }));
    const [a, b, c] = doc.items as DocxParagraph[];
    expect(a.style).toBe("场景标题");
    expect(a.align).toBe("center"); // 段落自身无 jc，经 basedOn 链继承
    expect(b.align).toBe("right");
    expect(c.indent).toBe(1204);    // 浮点碎片取整
    expect(doc.stats.paragraphs).toBe(3);
  });

  it("布尔属性按值判否：val=0/false/none 是关，缺省与 val=1 是开", async () => {
    const body = [
      p(r("真粗体", `<w:b/>`)),
      p(r("显式开", `<w:b w:val="1"/>`)),
      p(r("显式关", `<w:b w:val="0"/><w:u w:val="none"/>`)),
      p(r("真下划线", `<w:u w:val="single"/>`)),
    ].join("");
    const doc = await parse(docxOf(body));
    const flags = (i: number) => (doc.items[i] as DocxParagraph).flags ?? [];
    expect(flags(0)).toContain("b");
    expect(flags(1)).toContain("b");
    expect(flags(2)).toEqual([]);   // Google Docs 导出件的 val="none" 陷阱
    expect(flags(3)).toContain("u");
  });

  it("格式跨度：全段 b、部分 b~、微量不报", async () => {
    const body = [
      p(r("全段都是粗体的角色名", `<w:b/>`)),
      p(r("平文平文平文", "") + r("粗体段落片", `<w:b/>`)),   // ~5/11 ≈ 45% → b~
      p(r("很长很长很长很长很长很长的一句台词", "") + r("粗", `<w:b/>`)), // <15% → 不报
    ].join("");
    const doc = await parse(docxOf(body));
    expect((doc.items[0] as DocxParagraph).flags).toContain("b");
    expect((doc.items[1] as DocxParagraph).flags).toContain("b~");
    expect((doc.items[2] as DocxParagraph).flags ?? []).toEqual([]);
  });

  it("非文本对象出占位符并计数（mammoth 静默吞 OLE 的反面）", async () => {
    const body = [
      p(`<w:r><w:drawing><w:inline/></w:drawing></w:r>` + r("图后有字")),
      p(`<w:r><w:object><o:OLEObject/></w:object></w:r>`),
    ].join("");
    const doc = await parse(docxOf(body));
    const a = doc.items[0] as DocxParagraph;
    expect(a.text).toContain("⟦图⟧");
    expect(a.objects).toEqual(["drawing"]);
    const b = doc.items[1] as DocxParagraph;
    expect(b.text).toContain("⟦对象⟧");
    expect(b.objects).toEqual(["ole"]);
    expect(doc.stats.objects).toBe(2);
  });

  it("脚注：正文占位 + id 关联 + 伪注（id≤0）过滤", async () => {
    const footnotes = `
      <w:footnote w:type="separator" w:id="0"><w:p><w:r><w:t>sep</w:t></w:r></w:p></w:footnote>
      <w:footnote w:id="2"><w:p><w:r><w:t>没有 trapdoor 时改说这句台词。</w:t></w:r></w:p></w:footnote>`;
    const body = p(r("反派掉了下去") + `<w:r><w:footnoteReference w:id="2"/></w:r>`);
    const doc = await parse(docxOf(body, { footnotes }));
    const a = doc.items[0] as DocxParagraph;
    expect(a.text).toContain("⟦脚注2⟧");
    expect(a.footnotes).toEqual(["2"]);
    expect(doc.footnotes["2"]).toContain("trapdoor");
    expect(doc.footnotes["0"]).toBeUndefined();
    expect(doc.stats.footnotes).toBe(1);
  });

  it("表格整块进 IR、¶ 序号与段落连续", async () => {
    const body =
      p(r("表前段")) +
      `<w:tbl><w:tr><w:tc><w:p>${r("角色")}</w:p></w:tc><w:tc><w:p>${r("演员")}</w:p></w:tc></w:tr>` +
      `<w:tr><w:tc><w:p>${r("张三")}</w:p></w:tc><w:tc><w:p>${r("李四")}</w:p></w:tc></w:tr></w:tbl>` +
      p(r("表后段"));
    const doc = await parse(docxOf(body));
    expect(doc.items.length).toBe(3);
    const t = doc.items[1] as DocxTable;
    expect(t.kind).toBe("table");
    expect(t.rows).toEqual([["角色", "演员"], ["张三", "李四"]]);
  });

  it("表格单元格里的图也要占位并计数（Run Sheet 类文档整篇是表、图全在格里）", async () => {
    const body =
      `<w:tbl><w:tr><w:tc><w:p><w:r><w:drawing><w:inline/></w:drawing></w:r>${r("图旁说明")}</w:p></w:tc></w:tr></w:tbl>`;
    const doc = await parse(docxOf(body));
    const t = doc.items[0] as DocxTable;
    expect(t.rows[0][0]).toContain("⟦图⟧");
    expect(doc.stats.objects).toBe(1);
  });

  it("字体/字号只在偏离主流时报告", async () => {
    const body = [
      p(r("正文一句", `<w:rFonts w:ascii="宋体"/><w:sz w:val="21"/>`)),
      p(r("正文又一句", `<w:rFonts w:ascii="宋体"/><w:sz w:val="21"/>`)),
      p(r("唱词用仿宋", `<w:rFonts w:ascii="仿宋"/><w:sz w:val="21"/>`)),
    ].join("");
    const doc = await parse(docxOf(body));
    expect(doc.stats.majorityFont).toBe("宋体");
    expect((doc.items[0] as DocxParagraph).font).toBeUndefined();
    expect((doc.items[2] as DocxParagraph).font).toBe("仿宋");
  });

  it("空段不占 ¶ 号；tab/br 保真", async () => {
    const body = [
      p(""),
      p(`<w:r><w:t>前</w:t><w:tab/><w:t>后</w:t><w:br/><w:t>行二</w:t></w:r>`),
    ].join("");
    const doc = await parse(docxOf(body));
    expect(doc.items.length).toBe(1);
    expect((doc.items[0] as DocxParagraph).text).toBe("前\t后\n行二");
  });

  it("非 zip / 缺 document.xml 抛确定性 DocxParseError", async () => {
    await expect(parse(Buffer.from("not a zip at all, definitely"))).rejects.toThrow(DocxParseError);
    const noDoc = makeZip([{ name: "word/styles.xml", content: "<w:styles/>" }]);
    await expect(parse(noDoc)).rejects.toThrow(/word\/document\.xml/);
  });
});
