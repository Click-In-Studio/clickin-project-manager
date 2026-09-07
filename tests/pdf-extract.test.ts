// #47 pdf 文本层解析器测试。合成 fixture（测试内手写最小 PDF，真实剧本含
// 用户内容不入库）。覆盖三标本实测钉下的纪律：
// - 阅读轴间隙保真：词距补空格、大间隙显式 ⟨N⟩（横排 x / 竖排 y 同一条通则）；
// - 竖排靠相邻项步进投票（单字符项自身无方向信息——わが星实测）；
// - 空页诚实分诊：纯图页=rasterized、真空页=blank（宁缺毋假）；
// - 跨页重复行按「同文本+同位置」判 boilerplate（只按文本会误伤角色名——Burns 实测）。

import { describe, it, expect } from "vitest";
import { parsePdf, PdfParseError } from "@/lib/doc-extract/pdf";

// ─── 最小 PDF writer（未压缩流 + 手工 xref）─────────────────────────────────

type PageSpec = { content: string; image?: boolean };

function makePdf(pages: PageSpec[]): Buffer {
  const objs: string[] = []; // 1-based 对象体（不含头尾）
  const push = (body: string) => { objs.push(body); return objs.length; };

  const fontRef = push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  const imgRef = push(
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\xff\nendstream`,
  );

  const pageRefs: number[] = [];
  const kidsPlaceholder = push(``); // Pages 节点稍后回填
  for (const p of pages) {
    const contentRef = push(`<< /Length ${p.content.length} >>\nstream\n${p.content}\nendstream`);
    const res = `<< /Font << /F1 ${fontRef} 0 R >> ${p.image ? `/XObject << /Im0 ${imgRef} 0 R >>` : ""} >>`;
    pageRefs.push(push(
      `<< /Type /Page /Parent ${kidsPlaceholder} 0 R /MediaBox [0 0 612 792] /Resources ${res} /Contents ${contentRef} 0 R >>`,
    ));
  }
  objs[kidsPlaceholder - 1] =
    `<< /Type /Pages /Kids [ ${pageRefs.map((r) => `${r} 0 R`).join(" ")} ] /Count ${pageRefs.length} >>`;
  const catalogRef = push(`<< /Type /Catalog /Pages ${kidsPlaceholder} 0 R >>`);

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogRef} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const text = (x: number, y: number, s: string, size = 12) => `BT /F1 ${size} Tf ${x} ${y} Td (${s}) Tj ET\n`;

// ─── 测试 ────────────────────────────────────────────────────────────────────

describe("pdf 文本层信号抽取", () => {
  it("横排聚行：同 y 合行、词距补空格、大间隙显式 ⟨N⟩、行首 x 保真", async () => {
    const content =
      text(90, 700, "Hello") + text(124, 700, "world") + // 词距（~3.6pt）
      text(300, 700, "far") +                             // 大间隙
      text(90, 660, "second line");
    const doc = await parsePdf(makePdf([{ content }]));
    expect(doc.stats.pageCount).toBe(1);
    const p = doc.pages[0];
    expect(p.vertical).toBe(false);
    expect(p.status).toBe("ok");
    expect(p.lines.length).toBe(2);
    expect(p.lines[0].x).toBe(90);
    expect(p.lines[0].text).toMatch(/^Hello world ⟨\d+⟩ far$/);
    expect(p.lines[1].text).toBe("second line");
  });

  it("竖排：相邻项步进投票（单字符项）→ 列右→左、列内 y 间隙标 ⟨N⟩", async () => {
    // 右列：x=500 从上往下逐字；左列：x=470，中间空一字（段差）
    const col = (x: number, chars: string[], gapAfter = -1) =>
      chars.map((c, i) => text(x, 700 - i * 12 - (gapAfter >= 0 && i > gapAfter ? 12 : 0), c)).join("");
    const content = col(500, ["A", "B", "C", "D", "E"]) + col(470, ["X", "Y", "Z"], 0);
    const doc = await parsePdf(makePdf([{ content }]));
    const p = doc.pages[0];
    expect(p.vertical).toBe(true);
    expect(p.lines.length).toBe(2);
    expect(p.lines[0].x).toBe(500); // 右列在前（阅读序）
    expect(p.lines[0].text).toBe("ABCDE");
    expect(p.lines[1].text).toMatch(/^X⟨\d+⟩YZ$/); // 段差间隙显式保真
  });

  it("空页诚实分诊：纯图页=rasterized、真空页=blank（都不是没有内容）", async () => {
    const doc = await parsePdf(makePdf([
      { content: text(90, 700, "normal page") },
      { content: "q 10 0 0 10 100 100 cm /Im0 Do Q", image: true },
      { content: "" },
    ]));
    expect(doc.pages.map((p) => p.status)).toEqual(["ok", "rasterized", "blank"]);
    expect(doc.stats.rasterizedPages).toBe(1);
    expect(doc.stats.blankPages).toBe(1);
  });

  it("跨页重复行：同文本+同位置才标 boilerplate；同文本不同位置（角色名）不误伤", async () => {
    const pages: PageSpec[] = [];
    for (let i = 0; i < 5; i++) {
      pages.push({
        content:
          text(200, 30, "Watermark Footer Text") +      // 每页同位置
          text(90, 700 - i * 40, "MATTHEW") +           // 每页不同位置
          text(90, 660 - i * 40, "some dialogue here"),
      });
    }
    const doc = await parsePdf(makePdf(pages));
    expect(doc.boilerplate).toEqual(["Watermark Footer Text"]);
    const flagged = doc.pages.flatMap((p) => p.lines.filter((l) => l.boilerplate).map((l) => l.text));
    expect(flagged.every((t) => t === "Watermark Footer Text")).toBe(true);
    const matt = doc.pages[0].lines.find((l) => l.text === "MATTHEW");
    expect(matt?.boilerplate).toBeUndefined();
  });

  it("字体图例：短名去重、行仅在偏离主字体时标注", async () => {
    const doc = await parsePdf(makePdf([{ content: text(90, 700, "abc") + text(90, 660, "def") }]));
    expect(Object.keys(doc.fontLegend).length).toBeGreaterThanOrEqual(1);
    expect(doc.majorityFont).toBe("F1");
    for (const ln of doc.pages[0].lines) expect(ln.font).toBeUndefined(); // 全是主字体，不标
  });

  it("非 pdf 抛确定性 PdfParseError", async () => {
    await expect(parsePdf(Buffer.from("definitely not a pdf"))).rejects.toThrow(PdfParseError);
  });
});
