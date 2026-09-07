// #47 文档理解查询通道——pdf 文本层薄解析器（docx 见 ./docx.ts，纪律同源）。
//
// 剧本 pdf 是「排版位置即语义」的文体：坐标重建（聚行/缩进/居中/间隙）比一般
// 文档收益大。四标本实测钉下的纪律：
// - **阅读轴间隙保真**（横排 x 间隙 / 竖排 y 间隙）：字体 run 切换处 pdfjs 的
//   文本项不含空格，裸拼接出 "Bartisn't"；竖排间隙尺寸本身是记号（わが星的
//   段差=发话时序、角色缩写与台词的分隔）。间隙以 ⟨N⟩（pt）显式输出；
// - **cMaps 必须打包**：不配时 CJK 文本不是乱码而是**整页静默蒸发**（わが星
//   实测：文本层只剩页码，showText 却有 396 个）。资产目录多候选解析，缺失
//   时明确报错不静默；
// - **抽取不完整自检**：文本项近零的页要查绘制操作——有 showText 而抽取为零
//   ⇒ 标 extract-incomplete，有图无文 ⇒ rasterized，两者都不是 blank
//   （宁缺毋假，同 RF64 哨兵纪律）；
// - **竖排**：列按 x 聚类右→左、列内上→下；styles 的 vertical 旗标主判、
//   x/y 桶数比兜底；
// - **跨页重复行**（水印/页眉脚）机械检测标 ≡，数据层保持完整（展示层过滤
//   的思路，同 archive-view Mac 垃圾先例）；
// - 只出原始信号不下结论：x/y/字体/间隙原样报告，三大块判读留给 AI。
//
// 整文档急切解析后进 LRU（文件行不可变 ⇒ fileId 即键）；pdfjs Document 用完
// 即 destroy，缓存只留 IR。慢文档的流式/进度是既有挂账（#441 同族），不赊。

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { type ByteSource, TransientReadError } from "@/lib/asset/byte-source";

export const PDF_EXTRACTOR_VERSION = 2; // v2：+跨页续写标注 contNext/contPrev

const FILE_BYTES_CAP = 50 * 1024 * 1024;
const PAGES_CAP = 400;
/** 行内间隙超过 em 的此倍数时显式标 ⟨N⟩（普通词距只补空格）。 */
const GAP_MARK_EM = 1.6;
const SPACE_GAP_EM = 0.28;

export class PdfParseError extends Error {
  constructor(msg: string) { super(msg); this.name = "PdfParseError"; }
}

// ─── IR 类型 ─────────────────────────────────────────────────────────────────

export interface PdfLine {
  /** 行文本（词距补空格；大间隙以 ⟨N⟩ 显式标出，N=pt 取整）。 */
  text: string;
  /** 横排：行首 x；竖排：列的 x（阅读序右→左）。取整 pt。 */
  x: number;
  /** 横排：行基线 y；竖排：列顶 y（段差信号）。取整 pt。 */
  y: number;
  /** 行宽（横排）/列高（竖排）近似值，取整 pt。 */
  w: number;
  /** 行主字体（图例短名 F1/F2…；与全文档主字体一致时省略）。 */
  font?: string;
  /** 跨页重复行（水印/页眉脚）。 */
  boilerplate?: boolean;
  /** 本行是页末行且疑似句子未完（括号未闭合/无句末标点且下页小写续起）——
   *  与下页标 contPrev 的行很可能是同一段被分页截断（导入实测反馈②）。 */
  contNext?: boolean;
  /** 本行是页首行且疑似上一页末行（标 contNext）的继续。 */
  contPrev?: boolean;
}

export type PdfPageStatus = "ok" | "blank" | "rasterized" | "extract-incomplete";

export interface PdfPage {
  /** pdf 页序（1 起）。印刷页码可能与此不同——引用锚一律用页序。 */
  n: number;
  width: number;
  height: number;
  vertical: boolean;
  status: PdfPageStatus;
  lines: PdfLine[];
}

export interface PdfDoc {
  pages: PdfPage[];
  /** 字体图例：短名 → 原始 fontFamily/名字（traits 线索：italic/bold 等）。 */
  fontLegend: Record<string, string>;
  /** 全文档主字体短名（各行仅在偏离时标注）。 */
  majorityFont: string | null;
  /** 跨页重复行文本（已在行上标 boilerplate，此处汇总供 outline）。 */
  boilerplate: string[];
  stats: {
    pageCount: number;
    verticalPages: number;
    blankPages: number;
    rasterizedPages: number;
    incompletePages: number;
    /** cMaps/字体资产目录是否解析成功（false 时 CJK 文档必然 incomplete）。 */
    assetsAvailable: boolean;
  };
}

// ─── pdfjs 资产目录解析（Next standalone / agent-runner esbuild 两种形态）────

function pdfjsAssetDir(): string | null {
  const candidates: string[] = [];
  try {
    const req = createRequire(import.meta.url);
    candidates.push(path.dirname(req.resolve("pdfjs-dist/package.json")));
  } catch { /* esbuild 单文件形态下 resolve 可能失效，走 cwd 候选 */ }
  candidates.push(
    path.join(process.cwd(), "node_modules/pdfjs-dist"),
    path.join(process.cwd(), "../node_modules/pdfjs-dist"),
    path.join(process.cwd(), "../../node_modules/pdfjs-dist"),
  );
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, "cmaps"))) return c; } catch { /* 继续 */ }
  }
  return null;
}

// ─── 解析 ────────────────────────────────────────────────────────────────────

type TextItem = { str: string; transform: number[]; width?: number; height?: number; fontName?: string };
type TextStyle = { fontFamily?: string; vertical?: boolean };

export async function parsePdf(buf: Buffer): Promise<PdfDoc> {
  if (buf.length > FILE_BYTES_CAP) throw new PdfParseError(`pdf 过大（${buf.length} 字节，上限 ${FILE_BYTES_CAP}）`);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // 无 worker 环境下 pdfjs 会走 fake-worker：运行时动态 import worker 模块。
  // Next dev（Turbopack）会把那个动态导入改写成不存在的 chunk 路径
  // （"Cannot find module …/chunks/pdf.worker.mjs"，本地实测）。修法＝这里
  // 用**静态说明符**引入 worker 并挂 globalThis.pdfjsWorker——pdfjs 的
  // _setupFakeWorkerGlobal 检查到它就不再动态 import。
  if (!(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker) {
    // @ts-expect-error worker 构建无 .d.ts——只为副作用/句柄引入，不消费其类型
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  }
  const assetDir = pdfjsAssetDir();

  const loading = pdfjs.getDocument({
    data: new Uint8Array(buf),
    ...(assetDir ? {
      cMapUrl: path.join(assetDir, "cmaps") + path.sep,
      cMapPacked: true,
      standardFontDataUrl: path.join(assetDir, "standard_fonts") + path.sep,
      wasmUrl: path.join(assetDir, "wasm") + path.sep,   // JBIG2/JPX 解码器
      iccUrl: path.join(assetDir, "iccs") + path.sep,
    } : {}),
  });
  let doc;
  try {
    doc = await loading.promise;
  } catch (e) {
    throw new PdfParseError(`pdf 打开失败：${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    if (doc.numPages > PAGES_CAP) throw new PdfParseError(`pdf 页数过多（${doc.numPages} 页，上限 ${PAGES_CAP}）`);

    // 字体统计先按 pdfjs 内部名（g_d0_fN）聚，当页反解真实基名去重：
    // 每页重嵌字体子集时内部名逐页不同（Curtains 实测 199 个），基名才是身份，
    // 且基名里带 Italic/Bold——舞台指示常整段斜体，这个信号不能丢。
    // 反解要求字体对象已进 commonObjs——由每页先跑 getOperatorList 保证
    // （getTextContent 不填充 commonObjs，直接 get 会抛"not resolved"）。
    const rawFontChars = new Map<string, number>();
    const labelOfRaw = new Map<string, string>();

    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      // 先跑绘制流：①空页的诚实分诊需要它；②它把字体对象填进 commonObjs，
      // 才能反解真名。代价是每页双份解析，一次性（IR 进缓存）可接受。
      let opsCounts: { showText: number; images: number } | null = null;
      try {
        const ops = await page.getOperatorList();
        let showText = 0, images = 0;
        for (const f of ops.fnArray) {
          if (f === pdfjs.OPS.showText || f === pdfjs.OPS.showSpacedText) showText++;
          else if (f === pdfjs.OPS.paintImageXObject || f === pdfjs.OPS.paintInlineImageXObject || f === pdfjs.OPS.paintImageXObjectRepeat) images++;
        }
        opsCounts = { showText, images };
      } catch { /* 绘制流坏掉：状态判定按保守分支走 */ }

      const tc = await page.getTextContent();
      const styles = (tc.styles ?? {}) as Record<string, TextStyle>;
      const rawItems = tc.items as TextItem[];
      const items = rawItems.filter((it) => it.str.trim().length > 0);

      if (items.length === 0) {
        // 原始项非零但全是空白 ⇒ 抽取没失败，页面就是没有可见文本（blank）；
        // 只有原始项为零而绘制流里有 showText 才是真的抽取不完整（cMaps/编码）
        let status: PdfPageStatus;
        if (rawItems.length > 0) status = "blank";
        else if (opsCounts == null) status = "extract-incomplete"; // 绘制流坏掉也不谎报空白
        else if (opsCounts.showText > 0) status = "extract-incomplete";
        else if (opsCounts.images > 0) status = "rasterized";
        else status = "blank";
        pages.push({ n, width, height, vertical: false, status, lines: [] });
        continue;
      }

      // 当页反解字体真名（此页字体刚进 commonObjs）
      for (const it of items) {
        const raw = it.fontName;
        if (!raw || labelOfRaw.has(raw)) continue;
        let label: string | null = null;
        try {
          if (page.commonObjs.has(raw)) {
            const fo = page.commonObjs.get(raw) as { name?: string } | null;
            // 剥子集前缀（ABCDEF+Font-Italic）——逐页重嵌子集时前缀逐页不同，
            // 基名才能跨页去重
            if (fo?.name) label = fo.name.replace(/^[A-Z]{6}\+/, "");
          }
        } catch { /* 未解析走族名兜底 */ }
        labelOfRaw.set(raw, label ?? styles[raw]?.fontFamily ?? raw);
      }

      // 竖排判定：三路投票，全部按证据强度计票。
      // ①styles 的 vertical 旗标（CID 竖排字体）——最强证据，但很多竖排 pdf
      //   根本不用竖排字体机制（わが星实测：单字逐个摆放、旗标全 false）；
      // ②多字符项看自身推进方向——横排项 width≈字符数×字号（长条横躺）。
      //   不用"x/y 桶数比"（横排 pdf 常把整行发成单个文本项，x 桶天然少，
      //   会整卷误判成竖排——Burns 实测教训）；
      // ③相邻项步进——单字符项自身无方向信息，方向在排列里：Δx≈0 且
      //   Δy≈-字号 是竖排步进，Δy≈0 且 Δx>0 是横排步进（わが星实测正解）。
      let vVotes = 0, hVotes = 0;
      for (const it of items) {
        const len = it.str.replace(/\s/g, "").length;
        if (len === 0) continue;
        if (it.fontName && styles[it.fontName]?.vertical) { vVotes += len; continue; }
        if (len < 2) continue;
        const cs = charSizeOf(it);
        if ((it.width ?? 0) < cs * 0.7 && (it.height ?? 0) > cs * (len - 0.5)) vVotes += len;
        else if ((it.width ?? 0) > cs * (len * 0.35)) hVotes += len;
      }
      for (let i = 1; i < items.length; i++) {
        const a = items[i - 1], b = items[i];
        const cs = charSizeOf(b);
        const dx = b.transform[4] - a.transform[4];
        const dy = b.transform[5] - a.transform[5];
        if (Math.abs(dx) < cs * 0.4 && dy < -cs * 0.3 && dy > -cs * 2.5) vVotes++;
        else if (Math.abs(dy) < cs * 0.4 && dx > cs * 0.2 && dx < cs * 8) hVotes++;
      }
      const vertical = vVotes > hVotes;

      const lines = vertical
        ? buildVerticalColumns(items)
        : buildHorizontalLines(items);

      // 行主字体统计（暂存内部名，收尾统一反解）
      const outLines: PdfLine[] = lines.map((ln) => {
        const counts = new Map<string, number>();
        for (const it of ln.items) {
          if (!it.fontName) continue;
          counts.set(it.fontName, (counts.get(it.fontName) ?? 0) + it.str.length);
        }
        let bestFont: string | null = null, bestC = 0;
        for (const [f, c] of counts) if (c > bestC) { bestFont = f; bestC = c; }
        if (bestFont) rawFontChars.set(bestFont, (rawFontChars.get(bestFont) ?? 0) + bestC);
        return { text: ln.text, x: Math.round(ln.x), y: Math.round(ln.y), w: Math.round(ln.w), ...(bestFont ? { font: bestFont } : {}) };
      });
      pages.push({ n, width, height, vertical, status: "ok", lines: outLines });
    }

    // 按基名去重发短名 F1/F2…（基名已在各页循环内反解进 labelOfRaw）
    const shortByLabel = new Map<string, string>();
    const fontLegend: Record<string, string> = {};
    const shortOfRaw = (raw: string): string => {
      const label = labelOfRaw.get(raw) ?? raw;
      let s = shortByLabel.get(label);
      if (!s) {
        s = `F${shortByLabel.size + 1}`;
        shortByLabel.set(label, s);
        fontLegend[s] = label;
      }
      return s;
    };
    const fontCharTotal = new Map<string, number>();
    for (const [raw, c] of rawFontChars) {
      const s = shortOfRaw(raw);
      fontCharTotal.set(s, (fontCharTotal.get(s) ?? 0) + c);
    }
    let majorityFont: string | null = null, bestC = 0;
    for (const [f, c] of fontCharTotal) if (c > bestC) { majorityFont = f; bestC = c; }
    for (const p of pages) for (const ln of p.lines) {
      if (!ln.font) continue;
      const s = shortOfRaw(ln.font);
      if (s === majorityFont) delete ln.font;
      else ln.font = s;
    }

    // 跨页重复行（水印/页眉脚）：同文本**且同位置**（y 取整桶）在 ≥max(3, 40%
    // 非空页) 页出现。位置锚是关键——角色名也会高频复现，但每页 y 都不同；
    // 水印/页眉脚是位置稳定的（Burns 实测：不锚位置会把 MATT/JENNY 全误标）。
    const textPages = pages.filter((p) => p.lines.length > 0);
    const lineFreq = new Map<string, number>();
    const posKey = (t: string, y: number) => `${Math.round(y / 6)}@${t}`;
    for (const p of textPages) {
      const seen = new Set<string>();
      for (const ln of p.lines) {
        const t = ln.text.trim();
        if (t.length < 4) continue;
        const key = posKey(t, ln.y);
        if (seen.has(key)) continue;
        seen.add(key);
        lineFreq.set(key, (lineFreq.get(key) ?? 0) + 1);
      }
    }
    const threshold = Math.max(3, Math.ceil(textPages.length * 0.4));
    const hot = new Set([...lineFreq.entries()].filter(([, c]) => c >= threshold).map(([k]) => k));
    const boilerplateTexts = new Set<string>();
    if (hot.size) {
      for (const p of pages) for (const ln of p.lines) {
        if (hot.has(posKey(ln.text.trim(), ln.y))) {
          ln.boilerplate = true;
          boilerplateTexts.add(ln.text.trim());
        }
      }
    }
    const boilerplate = [...boilerplateTexts];

    // 跨页段落截断启发式（导入实测反馈②：同段被分页截断没有任何提示，导入
    // 会产生人为断块）。只出信号不下结论：
    // - 强判据：页末行括号未闭合（(（「『“[{ 多于对应闭合）；
    // - 弱判据：页末行无句末标点、够长（≥30 字符，排除角色名短行）、且下页
    //   首行以小写拉丁字母续起（CJK 无大小写，弱判据不触发——宁缺毋假）。
    const TERMINAL_RE = /[.。!?！？…”"』」)）\]}]$/;
    // 括号平衡刻意跨类型合并计数（「 开 ) 收也算配对）：启发式只要"有没有
    // 悬开的括号"这一位信号，分类型精确配对对乱嵌套的真实排版反而更脆
    const unbalancedOpen = (t: string): boolean => {
      let n = 0;
      for (const ch of t) {
        if ("(（「『“[{".includes(ch)) n++;
        else if (")）」』”]}".includes(ch)) n = Math.max(0, n - 1);
      }
      return n > 0;
    };
    for (let i = 0; i + 1 < pages.length; i++) {
      const a = pages[i], b = pages[i + 1];
      // 非 ok 页（栅格化/抽取不完整）明确排除——那类页的文本本身就是残缺的，
      // 边界启发式只会放大假阳性（宁缺毋假；当前实现非 ok 页 lines 恒空，
      // 此判是显式化+防将来部分抽取改动）
      if (a.status !== "ok" || b.status !== "ok") continue;
      if (a.vertical || b.vertical || a.lines.length === 0 || b.lines.length === 0) continue;
      const lastLn = [...a.lines].reverse().find((l) => !l.boilerplate);
      const firstLn = b.lines.find((l) => !l.boilerplate);
      if (!lastLn || !firstLn) continue;
      const txt = lastLn.text.trim(), nxt = firstLn.text.trim();
      const strong = unbalancedOpen(txt);
      const weak = !TERMINAL_RE.test(txt) && txt.length >= 30 && /^[a-z]/.test(nxt);
      if (strong || weak) {
        lastLn.contNext = true;
        firstLn.contPrev = true;
      }
    }

    return {
      pages,
      fontLegend,
      majorityFont,
      boilerplate,
      stats: {
        pageCount: pages.length,
        verticalPages: pages.filter((p) => p.vertical).length,
        blankPages: pages.filter((p) => p.status === "blank").length,
        rasterizedPages: pages.filter((p) => p.status === "rasterized").length,
        incompletePages: pages.filter((p) => p.status === "extract-incomplete").length,
        assetsAvailable: assetDir != null,
      },
    };
  } finally {
    // v6 起 destroy 挂在 loadingTask 上（连带释放 doc）
    await loading.destroy().catch(() => {});
  }
}

// ─── 聚行（横排）：y 分桶 → 行内按 x 排序 → 间隙保真拼接 ─────────────────────

type RawLine = { text: string; x: number; y: number; w: number; items: TextItem[] };

function charSizeOf(it: TextItem): number {
  return Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || it.height || 10;
}

function buildHorizontalLines(items: TextItem[]): RawLine[] {
  const buckets = new Map<number, TextItem[]>();
  for (const it of items) {
    const y = Math.round(it.transform[5] / 3) * 3;
    if (!buckets.has(y)) buckets.set(y, []);
    buckets.get(y)!.push(it);
  }
  const lines: RawLine[] = [];
  for (const [y, its] of [...buckets.entries()].sort((a, b) => b[0] - a[0])) {
    its.sort((a, b) => a.transform[4] - b.transform[4]);
    let text = "";
    let prevEnd: number | null = null;
    let prevFont: string | undefined;
    for (const it of its) {
      const x0 = it.transform[4];
      const em = charSizeOf(it);
      if (prevEnd != null) {
        const gap = x0 - prevEnd;
        // 跨字体边界（正文↔斜体等）用更宽容的阈值：run 切换处 pdfjs 不发空格
        // 项，间隙略小于正常词距也要补（"thenhegets" 实锤），代价可接受
        const spaceMin = it.fontName !== prevFont ? em * 0.12 : em * SPACE_GAP_EM;
        if (gap > em * GAP_MARK_EM) text += ` ⟨${Math.round(gap)}⟩ `;
        else if (gap > spaceMin && !text.endsWith(" ") && !it.str.startsWith(" ")) text += " ";
      }
      text += it.str;
      prevEnd = x0 + (it.width ?? it.str.length * em * 0.5);
      prevFont = it.fontName;
    }
    const x = its[0].transform[4];
    const last = its[its.length - 1];
    lines.push({ text, x, y, w: (last.transform[4] + (last.width ?? 0)) - x, items: its });
  }
  return lines;
}

// ─── 聚列（竖排）：x 分桶右→左 → 列内上→下 → y 间隙保真 ──────────────────────

function buildVerticalColumns(items: TextItem[]): RawLine[] {
  const buckets = new Map<number, TextItem[]>();
  for (const it of items) {
    const x = Math.round(it.transform[4] / 10) * 10;
    if (!buckets.has(x)) buckets.set(x, []);
    buckets.get(x)!.push(it);
  }
  const cols: RawLine[] = [];
  for (const [x, its] of [...buckets.entries()].sort((a, b) => b[0] - a[0])) {
    its.sort((a, b) => b.transform[5] - a.transform[5]);
    let text = "";
    let prevBottom: number | null = null;
    const yTop = its[0].transform[5];
    let yBottom = yTop;
    for (const it of its) {
      const top = it.transform[5];
      const cs = charSizeOf(it);
      if (prevBottom != null) {
        const gap = prevBottom - top;
        if (gap > cs * 0.6) text += `⟨${Math.round(gap)}⟩`;
      }
      text += it.str;
      prevBottom = top - it.str.length * cs;
      yBottom = prevBottom;
    }
    cols.push({ text, x, y: yTop, w: yTop - yBottom, items: its });
  }
  return cols;
}

// 进程内缓存已移到 lib/doc-extract/load.ts（解析本体在 heavy-worker 进程做，
// 调用方经任务队列 + R2 IR 取产物；文件行不可变 ⇒ fileId 即键的纪律不变）。

/** 整文件读入（pdfjs 需要完整 buffer；ByteSource 统一走这里保 TransientReadError 语义）。 */
export async function readAll(src: ByteSource): Promise<Buffer> {
  if (src.size == null) throw new PdfParseError("文件大小未知，无法读取");
  if (src.size > FILE_BYTES_CAP) throw new PdfParseError(`pdf 过大（${src.size} 字节，上限 ${FILE_BYTES_CAP}）`);
  const buf = await src.read(0, src.size);
  if (buf.length < src.size) throw new TransientReadError(`短读：${buf.length}/${src.size}`);
  return buf;
}
