// #47 文档理解查询通道——docx 薄解析器。
//
// 定位：给 agent 的**结构信号抽取**，不是内容转换。mammoth 类语义转换库在
// 这里是反面选型——它们刻意丢弃对齐/缩进/字体等排版信号，而剧本恰恰是
// 「排版即语义」的文体（居中大写=角色名、缩进档=对白/唱词、粗体=cue 标注）。
// 纪律（实测四标本定谳，见 #47）：
// - 只出原始信号不下结论：align/indent/字体原样报告，块级解读（三大块映射
//   假设、歌词判据）留给 AI 的分诊协议；
// - 可见性先于分诊：非文本对象（图片/OLE 谱例图例）必须以占位符+位置吐出，
//   AI 问不出它看不见的东西（mammoth 会静默吞 OLE，前车之鉴）；
// - 布尔属性按值判否：`w:b w:val="0"`/`w:u val="none"` 是关不是开
//   （Google Docs 导出件里 val="none" 比真下划线多一个量级）；
// - 脚注是一等公民：替换台词常以脚注形态存在（TRW 租赁本制度化用星号）。
//
// 与 #85 元数据管线是两条轨（office 当时拍板不进元数据管线）：这里整读内容、
// 无信封落盘，缓存是进程内 LRU（文件行不可变 ⇒ fileId 即缓存键；单 fork
// 实例前提，搬机器改 DB/R2 缓存）。复用其 ByteSource/openZipEntrySource。

import { XMLParser } from "fast-xml-parser";
import { type ByteSource, TransientReadError } from "@/lib/asset/byte-source";
import { openZipEntrySource } from "@/lib/asset/metadata-parsers";

/** 抽取器版本：改信号词表/修解析 bug 时 bump，进程内缓存随之失效。 */
export const DOCX_EXTRACTOR_VERSION = 1;

/** document.xml 解压后上限（超出=确定性 oversized；剧本级 docx 远够用）。 */
const XML_BYTES_CAP = 32 * 1024 * 1024;

// ─── IR 类型 ─────────────────────────────────────────────────────────────────

export interface DocxParagraph {
  kind: "p";
  /** 纯文本（run 拼接；tab→\t、br→\n；非文本对象以 ⟦…⟧ 占位内联）。 */
  text: string;
  /** 命名样式（styles.xml 解析出的显示名；无样式=undefined，初创剧本常态）。 */
  style?: string;
  /** 段落对齐（w:jc：left/center/right/both…；未声明=undefined）。 */
  align?: string;
  /** 左缩进 twips（w:ind left+firstLine 合并取整；浮点碎片常见，消费方聚类）。 */
  indent?: number;
  /**
   * 格式跨度信号（按字符占比）：全段格式=裸标（"b"），部分格式=加~（"b~"）。
   * 只报 b/i/u 三种；(0.85, 1] 记全段、[0.15, 0.85] 记部分、以下不报。
   */
  flags?: string[];
  /** 非主流字体（与全文档主字体不同才报，报字符占比最高的一个）。 */
  font?: string;
  /** 非主流字号（半磅值；与文档主字号差 ≥1 才报）。 */
  sz?: number;
  /** 非文本对象（drawing=图片/图形，ole=内嵌对象如谱例）。 */
  objects?: Array<"drawing" | "ole">;
  /** 引用的脚注/尾注 id（正文以 ⟦脚注N⟧ 占位）。 */
  footnotes?: string[];
}

export interface DocxTable {
  kind: "table";
  /** 单元格文本（行×列；超 cap 截断）。 */
  rows: string[][];
  truncated?: boolean;
}

export type DocxItem = DocxParagraph | DocxTable;

export interface DocxDoc {
  /** 顶层块序列（段落与表格混排，下标即 ¶ 号——工具引用锚点）。 */
  items: DocxItem[];
  /** 脚注/尾注 id → 文本（尾注 id 加 "e" 前缀防撞）。 */
  footnotes: Record<string, string>;
  stats: {
    paragraphs: number;
    tables: number;
    objects: number;
    footnotes: number;
    /** 全文档主字体/主字号（按字符数加权众数）。 */
    majorityFont: string | null;
    majoritySz: number | null;
  };
}

/** 确定性解析失败（结构损坏/超限/加密），非瞬态——调用方可直接回给模型。 */
export class DocxParseError extends Error {
  constructor(msg: string) { super(msg); this.name = "DocxParseError"; }
}

// ─── zip 定名查找（EOCD → central directory）────────────────────────────────
// 刻意不复用 zipParser：那边是元数据管线的全量清单+信封版本契约，这里只要
// 按名找 word/*.xml 几个条目，耦合进去反而两头改版本。EOCD 读法同源同参。

const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

type ZipEntry = {
  offset: number; method: number; compressedBytes: number;
  uncompressedBytes: number | null; encrypted: boolean;
};

async function findZipEntries(
  src: ByteSource, wanted: ReadonlySet<string>,
): Promise<Map<string, ZipEntry>> {
  if (src.size == null) throw new DocxParseError("文件大小未知，无法定位 zip 目录");
  let tailLen = Math.min(src.size, 4096);
  let tail = await src.read(src.size - tailLen, tailLen);
  let idx = tail.lastIndexOf(EOCD_SIG);
  if (idx < 0 && src.size > tailLen) {
    tailLen = Math.min(src.size, 22 + 65535);
    tail = await src.read(src.size - tailLen, tailLen);
    idx = tail.lastIndexOf(EOCD_SIG);
  }
  if (idx < 0 || idx + 22 > tail.length) throw new DocxParseError("不是有效的 zip/docx（EOCD 缺失）");
  const cdSize = tail.readUInt32LE(idx + 12);
  const cdOffset = tail.readUInt32LE(idx + 16);
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new DocxParseError("zip64 docx 超出支持范围");
  const cd = await src.read(cdOffset, Math.min(cdSize, 4 * 1024 * 1024));
  const out = new Map<string, ZipEntry>();
  let off = 0;
  while (off + 46 <= cd.length && out.size < wanted.size) {
    if (cd.readUInt32LE(off) !== 0x02014b50) break;
    const flags = cd.readUInt16LE(off + 8);
    const method = cd.readUInt16LE(off + 10);
    const compressedBytes = cd.readUInt32LE(off + 20);
    const uncompressedBytes = cd.readUInt32LE(off + 24);
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    const offset = cd.readUInt32LE(off + 42);
    if (off + 46 + nameLen > cd.length) break;
    // docx 部件名是 OOXML 规定的 ASCII 路径，不涉 GBK 猜码问题
    const name = cd.toString("utf8", off + 46, off + 46 + nameLen);
    if (wanted.has(name)) {
      out.set(name, {
        offset, method, compressedBytes,
        uncompressedBytes: uncompressedBytes === 0xffffffff ? null : uncompressedBytes,
        encrypted: (flags & 0x1) !== 0,
      });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntryText(src: ByteSource, entry: ZipEntry): Promise<string> {
  const size = entry.uncompressedBytes ?? entry.compressedBytes;
  if (size > XML_BYTES_CAP) throw new DocxParseError(`XML 部件过大（${size} 字节）`);
  const es = await openZipEntrySource(src, entry).catch((e) => {
    if (e instanceof TransientReadError) throw e;
    throw new DocxParseError(`docx 部件读取失败：${e instanceof Error ? e.message : String(e)}`);
  });
  const buf = await es.read(0, es.size ?? size);
  return buf.toString("utf8");
}

// ─── OOXML 解析 ──────────────────────────────────────────────────────────────

type XmlNode = Record<string, unknown> & { ":@"?: Record<string, string> };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  preserveOrder: true,
  // OOXML 里数值属性有浮点碎片（Google Docs 导出），保持字符串自己转
  parseAttributeValue: false,
  parseTagValue: false,
});

function children(node: XmlNode, key: string): XmlNode[] {
  const v = node[key];
  return Array.isArray(v) ? (v as XmlNode[]) : [];
}
function attr(node: XmlNode, name: string): string | undefined {
  return node[":@"]?.[`@${name}`];
}
function findChild(nodes: XmlNode[], key: string): XmlNode | undefined {
  return nodes.find((n) => key in n);
}
/** 布尔 run/para 属性按值判否：缺省=开、"0"/"false"/"none"=关。 */
function boolProp(node: XmlNode): boolean {
  const v = attr(node, "w:val");
  return v !== "0" && v !== "false" && v !== "none";
}

/** styles.xml → styleId → { name, 链上的 jc }（basedOn 链最多爬 6 层防环）。 */
function parseStyles(xml: string | null): Map<string, { name: string; align?: string }> {
  const out = new Map<string, { name: string; align?: string }>();
  if (!xml) return out;
  const raw = new Map<string, { name: string; basedOn?: string; align?: string }>();
  const walk = (nodes: XmlNode[]) => {
    for (const n of nodes) {
      if ("w:style" in n) {
        const id = attr(n, "w:styleId");
        if (!id) continue;
        const body = children(n, "w:style");
        const name = attr(findChild(body, "w:name") ?? {}, "w:val") ?? id;
        const basedOn = attr(findChild(body, "w:basedOn") ?? {}, "w:val");
        const pPr = findChild(body, "w:pPr");
        const align = pPr ? attr(findChild(children(pPr, "w:pPr"), "w:jc") ?? {}, "w:val") : undefined;
        raw.set(id, { name, basedOn, align });
      } else {
        for (const k of Object.keys(n)) if (k !== ":@" && Array.isArray(n[k])) walk(n[k] as XmlNode[]);
      }
    }
  };
  walk(parser.parse(xml) as XmlNode[]);
  for (const [id, s] of raw) {
    let align = s.align;
    let cur = s.basedOn;
    for (let hop = 0; align === undefined && cur && hop < 6; hop++) {
      const parent = raw.get(cur);
      if (!parent) break;
      align = parent.align;
      cur = parent.basedOn;
    }
    out.set(id, { name: s.name, align });
  }
  return out;
}

/** footnotes.xml / endnotes.xml → id → 文本。 */
function parseNotes(xml: string | null, idPrefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!xml) return out;
  const walk = (nodes: XmlNode[]) => {
    for (const n of nodes) {
      const key = "w:footnote" in n ? "w:footnote" : "w:endnote" in n ? "w:endnote" : null;
      if (key) {
        const id = attr(n, "w:id");
        // id 0/-1 是分隔符伪注，跳过
        if (id && Number(id) > 0) {
          const texts: string[] = [];
          collectText(children(n, key), texts);
          out[idPrefix + id] = texts.join("").trim();
        }
      } else {
        for (const k of Object.keys(n)) if (k !== ":@" && Array.isArray(n[k])) walk(n[k] as XmlNode[]);
      }
    }
  };
  walk(parser.parse(xml) as XmlNode[]);
  return out;
}

/** 纯文本收集（表格单元格/脚注用）。非文本对象也要占位——表格里的图
 *  同样受"可见性先于分诊"纪律约束（Run Sheet 类文档整篇是表、图全在格里）。 */
function collectText(nodes: XmlNode[], out: string[], counter?: { objects: number }) {
  for (const n of nodes) {
    if ("w:t" in n) {
      const t = (n["w:t"] as Array<{ "#text"?: string }>)[0]?.["#text"];
      if (t != null) out.push(String(t));
    } else if ("w:tab" in n) out.push("\t");
    else if ("w:br" in n) out.push("\n");
    else if ("w:drawing" in n || "w:pict" in n) { out.push("⟦图⟧"); if (counter) counter.objects++; }
    else if ("w:object" in n) { out.push("⟦对象⟧"); if (counter) counter.objects++; }
    else if (":@" in n || Object.keys(n).length > 0) {
      for (const k of Object.keys(n)) if (k !== ":@" && Array.isArray(n[k])) collectText(n[k] as XmlNode[], out, counter);
    }
  }
}

const TABLE_ROW_CAP = 60;
const CELL_TEXT_CAP = 400;

interface RunAgg {
  text: string;
  chars: number;
  bChars: number; iChars: number; uChars: number;
  fontChars: Map<string, number>;
  szChars: Map<number, number>;
  objects: Array<"drawing" | "ole">;
  footnotes: string[];
}

function newAgg(): RunAgg {
  return { text: "", chars: 0, bChars: 0, iChars: 0, uChars: 0, fontChars: new Map(), szChars: new Map(), objects: [], footnotes: [] };
}

/** 递归收集一个段落里的 runs（含 hyperlink/smartTag 等包裹层）。 */
function collectRuns(nodes: XmlNode[], agg: RunAgg) {
  for (const n of nodes) {
    if ("w:r" in n) {
      const body = children(n, "w:r");
      const rPr = findChild(body, "w:rPr");
      let b = false, i = false, u = false;
      let font: string | undefined, sz: number | undefined;
      if (rPr) {
        for (const p of children(rPr, "w:rPr")) {
          if ("w:b" in p) b = boolProp(p);
          else if ("w:i" in p) i = boolProp(p);
          else if ("w:u" in p) u = boolProp(p);
          else if ("w:rFonts" in p) font = attr(p, "w:ascii") ?? attr(p, "w:eastAsia");
          else if ("w:sz" in p) { const v = Number(attr(p, "w:val")); if (Number.isFinite(v)) sz = Math.round(v * 2) / 2; }
        }
      }
      let text = "";
      for (const c of body) {
        if ("w:t" in c) text += String((c["w:t"] as Array<{ "#text"?: string }>)[0]?.["#text"] ?? "");
        else if ("w:tab" in c) text += "\t";
        else if ("w:br" in c) text += "\n";
        else if ("w:drawing" in c || "w:pict" in c) { agg.objects.push("drawing"); agg.text += "⟦图⟧"; }
        else if ("w:object" in c) { agg.objects.push("ole"); agg.text += "⟦对象⟧"; }
        else if ("w:footnoteReference" in c) {
          const id = attr(c, "w:id");
          if (id) { agg.footnotes.push(id); agg.text += `⟦脚注${id}⟧`; }
        } else if ("w:endnoteReference" in c) {
          const id = attr(c, "w:id");
          if (id) { agg.footnotes.push("e" + id); agg.text += `⟦尾注${id}⟧`; }
        }
      }
      if (text) {
        agg.text += text;
        const len = text.replace(/\s/g, "").length;
        agg.chars += len;
        if (b) agg.bChars += len;
        if (i) agg.iChars += len;
        if (u) agg.uChars += len;
        if (font && len) agg.fontChars.set(font, (agg.fontChars.get(font) ?? 0) + len);
        if (sz != null && len) agg.szChars.set(sz, (agg.szChars.get(sz) ?? 0) + len);
      }
    } else if (":@" in n || Object.keys(n).length > 0) {
      for (const k of Object.keys(n)) {
        // 不进 pPr（段属性另行处理）；其余包裹层（hyperlink/ins/smartTag）继续下钻
        if (k !== ":@" && k !== "w:pPr" && Array.isArray(n[k])) collectRuns(n[k] as XmlNode[], agg);
      }
    }
  }
}

function spanFlag(part: number, whole: number, letter: string): string | null {
  if (whole === 0) return null;
  const r = part / whole;
  if (r > 0.85) return letter;
  if (r >= 0.15) return letter + "~";
  return null;
}

/** 解析 docx 全文为 IR。src 为整文件 ByteSource（r2/buffer 均可）。 */
export async function parseDocx(src: ByteSource): Promise<DocxDoc> {
  const wanted = new Set(["word/document.xml", "word/styles.xml", "word/footnotes.xml", "word/endnotes.xml"]);
  const entries = await findZipEntries(src, wanted);
  const docEntry = entries.get("word/document.xml");
  if (!docEntry) throw new DocxParseError("不是 docx（缺 word/document.xml）");
  if (docEntry.encrypted) throw new DocxParseError("docx 已加密，无法解析");

  const [docXml, stylesXml, footXml, endXml] = await Promise.all([
    readEntryText(src, docEntry),
    entries.has("word/styles.xml") ? readEntryText(src, entries.get("word/styles.xml")!) : Promise.resolve(null),
    entries.has("word/footnotes.xml") ? readEntryText(src, entries.get("word/footnotes.xml")!) : Promise.resolve(null),
    entries.has("word/endnotes.xml") ? readEntryText(src, entries.get("word/endnotes.xml")!) : Promise.resolve(null),
  ]);

  const styles = parseStyles(stylesXml);
  const footnotes = { ...parseNotes(footXml, ""), ...parseNotes(endXml, "e") };

  const tree = parser.parse(docXml) as XmlNode[];
  const docNode = findChild(tree, "w:document");
  const bodyNode = docNode ? findChild(children(docNode, "w:document"), "w:body") : undefined;
  if (!bodyNode) throw new DocxParseError("document.xml 结构异常（缺 w:body）");

  const items: DocxItem[] = [];
  const fontTotal = new Map<string, number>();
  const szTotal = new Map<number, number>();
  let objectCount = 0;

  const pushParagraph = (p: XmlNode) => {
    const body = children(p, "w:p");
    const pPr = findChild(body, "w:pPr");
    let styleId: string | undefined, align: string | undefined, indent: number | undefined;
    if (pPr) {
      for (const n of children(pPr, "w:pPr")) {
        if ("w:pStyle" in n) styleId = attr(n, "w:val");
        else if ("w:jc" in n) align = attr(n, "w:val");
        else if ("w:ind" in n) {
          const left = Number(attr(n, "w:left") ?? attr(n, "w:start") ?? 0);
          const first = Number(attr(n, "w:firstLine") ?? 0);
          const v = Math.round((Number.isFinite(left) ? left : 0) + (Number.isFinite(first) ? first : 0));
          if (v !== 0) indent = v;
        }
      }
    }
    const styleInfo = styleId ? styles.get(styleId) : undefined;
    if (align === undefined) align = styleInfo?.align;

    const agg = newAgg();
    collectRuns(body, agg);
    if (!agg.text.trim() && agg.objects.length === 0) return; // 空段不进 IR（¶ 号以内容段计）

    for (const [f, c] of agg.fontChars) fontTotal.set(f, (fontTotal.get(f) ?? 0) + c);
    for (const [s, c] of agg.szChars) szTotal.set(s, (szTotal.get(s) ?? 0) + c);
    objectCount += agg.objects.length;

    const flags = [
      spanFlag(agg.bChars, agg.chars, "b"),
      spanFlag(agg.iChars, agg.chars, "i"),
      spanFlag(agg.uChars, agg.chars, "u"),
    ].filter((x): x is string => x != null);

    const para: DocxParagraph = { kind: "p", text: agg.text };
    if (styleInfo) para.style = styleInfo.name;
    if (align) para.align = align;
    if (indent != null) para.indent = indent;
    if (flags.length) para.flags = flags;
    if (agg.objects.length) para.objects = agg.objects;
    if (agg.footnotes.length) para.footnotes = agg.footnotes;
    // font/sz 的"非主流才报"需要全文档众数，先挂原始聚合，收尾统一决算
    (para as DocxParagraph & { _fonts?: Map<string, number>; _szs?: Map<number, number> })._fonts = agg.fontChars;
    (para as DocxParagraph & { _fonts?: Map<string, number>; _szs?: Map<number, number> })._szs = agg.szChars;
    items.push(para);
  };

  const objCounter = { objects: 0 };
  const pushTable = (t: XmlNode) => {
    const rows: string[][] = [];
    let truncated = false;
    for (const rowNode of children(t, "w:tbl")) {
      if (!("w:tr" in rowNode)) continue;
      if (rows.length >= TABLE_ROW_CAP) { truncated = true; break; }
      const cells: string[] = [];
      for (const cellNode of children(rowNode, "w:tr")) {
        if (!("w:tc" in cellNode)) continue;
        const texts: string[] = [];
        collectText(children(cellNode, "w:tc"), texts, objCounter);
        let cell = texts.join("").replace(/\s+/g, " ").trim();
        if (cell.length > CELL_TEXT_CAP) { cell = cell.slice(0, CELL_TEXT_CAP) + "…"; truncated = true; }
        cells.push(cell);
      }
      rows.push(cells);
    }
    items.push({ kind: "table", rows, ...(truncated ? { truncated: true } : {}) });
  };

  for (const node of children(bodyNode, "w:body")) {
    if ("w:p" in node) pushParagraph(node);
    else if ("w:tbl" in node) pushTable(node);
  }

  const majority = <K,>(m: Map<K, number>): K | null => {
    let best: K | null = null, bestC = 0;
    for (const [k, c] of m) if (c > bestC) { best = k; bestC = c; }
    return best;
  };
  const majorityFont = majority(fontTotal);
  const majoritySz = majority(szTotal);

  // 决算 font/sz：只在与主流不同的段上报（保持行紧凑）
  for (const it of items) {
    if (it.kind !== "p") continue;
    const p = it as DocxParagraph & { _fonts?: Map<string, number>; _szs?: Map<number, number> };
    const f = p._fonts ? majority(p._fonts) : null;
    if (f && f !== majorityFont) it.font = f;
    const s = p._szs ? majority(p._szs) : null;
    if (s != null && majoritySz != null && Math.abs(s - majoritySz) >= 1) it.sz = s;
    else if (s != null && majoritySz == null) it.sz = s;
    delete p._fonts;
    delete p._szs;
  }

  return {
    items,
    footnotes,
    stats: {
      paragraphs: items.filter((i) => i.kind === "p").length,
      tables: items.filter((i) => i.kind === "table").length,
      objects: objectCount + objCounter.objects,
      footnotes: Object.keys(footnotes).length,
      majorityFont,
      majoritySz,
    },
  };
}

// 进程内缓存已移到 lib/doc-extract/load.ts（解析本体在 heavy-worker 进程做，
// 调用方经任务队列 + R2 IR 取产物；文件行不可变 ⇒ fileId 即键的纪律不变）。
