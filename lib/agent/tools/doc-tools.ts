// #47 文档理解查询通道——agent 三工具（production.doc_outline / doc_read / doc_search）。
//
// 定位：让 agent 能"读懂"上传的剧本类文档（docx + pdf 文本层），配合指示
// skill 的分诊协议做 AI 辅助导入。设计定谳（四标本实测，见 #47 / 记忆）：
// - outline=建地图不灌正文：直方图（样式/对齐/缩进聚类/字体）+ 抽样预览，
//   AI 据此提"三大块映射假设"（角色名/对白/舞台指示），不预设任何排版惯例
//   ——all caps 是英文惯例，中文本常用居中或换字体（信号词表通用、映射每文档）；
// - read=紧凑行式标注，锚点可引用（docx=块号 ¶N；pdf=页序 pN.行号）；批量区间；
// - search=先定位再精读（search-then-read 比线性扫便宜一个量级）；
// - 文档内容是不可信文本：输出统一过 neutralizeInjectionTags；
// - 权限口径＝asset meta face（与 preview-url 同门：能预览即能读内容）。

import { resolveProductionActor, DENIED_NOT_MEMBER } from "./production-tools";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { getAsset, resolveAssetFile, listAssets } from "@/lib/asset/db";
import { canViewAsset, filterVisibleAssets } from "@/lib/asset/perm";
import { getWiki } from "@/lib/wiki/content";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { TransientReadError } from "@/lib/asset/byte-source";
import { loadParsedDocx, loadParsedPdf } from "@/lib/doc-extract/load";
import { presignedGet } from "@/lib/r2";
import { ocrPages, type OcrPage, type OcrTier } from "@/lib/mmp/ocr";
import { recordMmpUsage } from "@/lib/mmp/usage-db";
import type { Asset, AssetFile } from "@/lib/asset/db";
import type { DocxDoc, DocxItem, DocxParagraph } from "@/lib/doc-extract/docx";
import type { PdfDoc, PdfPage } from "@/lib/doc-extract/pdf";

export const DENIED_ASSET_VIEW = "权限被拒绝：你没有查看该资产的权限。";
const TRANSIENT_MSG = "文件读取暂时失败（存储层瞬态错误），请稍后重试。";
const LIST_CAP = 100;

/** doc_read 单次调用最多返回的 docx 块数 / pdf 行数（超出让模型分批）。 */
const READ_ITEM_CAP = 150;
const READ_PDF_LINE_CAP = 400;
/** doc_read 单次输出总字符预算——块数上限挡不住长段（150×1200 最坏 18 万字
 *  符=一次工具结果几万 token，是单回合成本硬顶的直接推手，2026-09-07 实测）。 */
const READ_CHAR_BUDGET = 24_000;
/** pdf 单次最多读的页数。 */
const READ_PDF_PAGE_CAP = 10;
/** 单段文本上限（保上下文预算；超长段截断并标注，模型可按锚点用更小范围重读）。 */
const READ_TEXT_CAP = 1200;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const OUTLINE_PREVIEW_COUNT = 12;
/** 缩进聚类桶宽：docx twips / pdf pt。缩进值常带浮点碎片，聚类后才可读。 */
const INDENT_BUCKET = 120;
const PDF_X_BUCKET = 10;

// ─── asset_list：资产枚举（id 供给入口）─────────────────────────────────────
// 实测催生（2026-09-07 用户本地测试）：没有它，用户不在资产预览页时 AI 对
// "帮我读那个 pdf"是死路——文件明明在库里，AI 却没有任何入口找到它。
// 与 wiki_tree（全树含 [文件] 行）互补：树给结构、这里给平铺+按名过滤。
// 可见性口径＝filterVisibleAssets（能力票∧结构面∧is_public 合取，与资产
// 列表页同源）。

export async function assetList(
  userId: string, productionId: string,
  opts: { query?: string } = {},
): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  const all = await listAssets(productionId);
  const visible = await filterVisibleAssets(resolved.actor, productionId, all);
  const q = opts.query?.trim().toLowerCase();
  const matched = q
    ? visible.filter((a) => a.fileName.toLowerCase().includes(q) || (a.name ?? "").toLowerCase().includes(q))
    : visible;
  if (matched.length === 0) {
    return q ? `没有找到匹配「${neutralizeInjectionTags(q)}」的资产。` : "该制作还没有（你可见的）资产文件。";
  }
  const lines = matched.slice(0, LIST_CAP).map((a) => {
    const lower = a.fileName.toLowerCase();
    const parseable = lower.endsWith(".docx") || lower.endsWith(".pdf");
    const label = a.name && a.name !== a.fileName ? `${a.name}（${a.fileName}）` : a.fileName;
    const extra = [
      a.assetType,
      a.storageType !== "r2" ? "外部链接" : null,
      parseable ? "可解析→doc_outline" : null,
    ].filter(Boolean).join("，");
    return `- 《${label}》 id: ${a.id}（${extra}）`;
  });
  const head = matched.length > LIST_CAP
    ? `共 ${matched.length} 个资产（显示前 ${LIST_CAP}，用 query 过滤）：`
    : `共 ${matched.length} 个资产：`;
  return neutralizeInjectionTags([head, ...lines].join("\n"));
}

// ─── 装载（权限门 + 格式分派）───────────────────────────────────────────────

type Loaded =
  | { kind: "docx"; doc: DocxDoc; fileName: string }
  | { kind: "pdf"; doc: PdfDoc; fileName: string };

/** 工具透传的会话上下文：解析超时转后台时，worker 终局后按它插话唤醒本会话。 */
export interface DocToolOpts {
  sessionId?: string | null;
}

/** 权限门 + 取文件行：doc_* 与 doc_page_ocr 共用（口径 = asset meta face，与预览同门）。 */
async function resolveReadableAsset(
  userId: string, productionId: string, assetId: string,
): Promise<{ asset: Asset; file: AssetFile & { r2Key: string } } | string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== productionId) {
    // 误用反馈（2026-09-07 定谳：用错工具要明确指路，不是干巴巴"没找到"）：
    // wiki id 是 uuid、资产 id 是短 text——uuid 形态的先查是不是文档
    if (UUID_RE.test(assetId)) {
      const wiki = await getWiki(assetId, productionId).catch(() => null);
      if (wiki) return `该 id 是 wiki 文档《${wiki.title ?? "（无标题）"}》——用 production.wiki_read 读取；doc_* 工具只读资产文件（树里的 [文件] 行）。`;
    }
    return "没有找到该资产（资产 id 来自树里的 [文件] 行或 production.asset_list）。";
  }
  if (!await canViewAsset(resolved.actor, productionId, asset, "meta")) return DENIED_ASSET_VIEW;
  if (asset.storageType !== "r2") return "该资产不是本站存储的文件（如飞书链接），无法解析。";
  const file = await resolveAssetFile(assetId);
  if (!file?.r2Key) return "该资产没有可读的文件内容。";
  return { asset, file: { ...file, r2Key: file.r2Key } };
}

async function loadDoc(
  userId: string, productionId: string, assetId: string,
  opts: DocToolOpts = {},
): Promise<Loaded | string> {
  const got = await resolveReadableAsset(userId, productionId, assetId);
  if (typeof got === "string") return got;
  const { asset, file } = got;

  const name = asset.fileName ?? "";
  const lower = name.toLowerCase();
  const kind = lower.endsWith(".docx") ? "docx" : lower.endsWith(".pdf") ? "pdf" : null;
  if (!kind) {
    if (lower.endsWith(".doc"))
      return "老式 .doc（二进制格式）不支持解析——请把文件另存为 .docx 后重新上传。";
    return `该资产（${name || "无文件名"}）不是 .docx / .pdf 文档，暂不支持解析。`;
  }
  // 解析在 heavy-worker 进程做（lib/doc-extract/load.ts 双模式装载）：
  // 快路径命中缓存/IR 或短等内完成；慢路径转后台，worker 终局后插话唤醒本会话。
  const ref = { fileId: file.id, r2Key: file.r2Key, fileSize: file.fileSize, fileName: name };
  const loadOpts = { notifySessionId: opts.sessionId ?? null };
  try {
    if (kind === "docx") {
      const r = await loadParsedDocx(ref, loadOpts);
      if (r.status === "ok") return { kind, doc: r.doc, fileName: name };
      if (r.status === "failed") return `docx 解析失败：${r.error}`;
      return pendingMsg(name);
    }
    const r = await loadParsedPdf(ref, loadOpts);
    if (r.status === "ok") return { kind, doc: r.doc, fileName: name };
    if (r.status === "failed") return `pdf 解析失败：${r.error}`;
    return pendingMsg(name);
  } catch (e) {
    if (e instanceof TransientReadError) return TRANSIENT_MSG;
    throw e;
  }
}

function pendingMsg(fileName: string): string {
  return `《${fileName}》正在后台解析（大文档首次读取需要一些时间）。解析完成后系统会自动发消息提醒你继续——` +
    "在那之前不要反复重试本工具；可以先做其他事，或直接告知用户正在解析中。";
}

// ─── docx 行式渲染（信号只报不判——块级解读是模型的事）───────────────────────

function docxSignalTags(p: DocxParagraph): string {
  const tags: string[] = [];
  if (p.style) tags.push(`样式:${p.style}`);
  if (p.align) tags.push(p.align);
  if (p.indent != null) tags.push(`ind=${p.indent}`);
  if (p.flags?.length) tags.push(p.flags.join(""));
  if (p.font) tags.push(`字体:${p.font}`);
  if (p.sz != null) tags.push(`sz=${p.sz}`);
  if (p.objects?.length) {
    const d = p.objects.filter((o) => o === "drawing").length;
    const o = p.objects.length - d;
    if (d) tags.push(`⟦图×${d}⟧`);
    if (o) tags.push(`⟦对象×${o}⟧`);
  }
  return tags.join(" ");
}

function renderDocxItem(idx: number, item: DocxItem, textCap: number): string {
  if (item.kind === "table") {
    const cols = item.rows[0]?.length ?? 0;
    const head = `[¶${idx} 表格 ${item.rows.length}×${cols}${item.truncated ? " 截断" : ""}]`;
    const rows = item.rows.slice(0, 20).map((r) => "  " + r.join(" | "));
    if (item.rows.length > 20) rows.push(`  …（共 ${item.rows.length} 行，用更小范围或按需另读）`);
    return [head, ...rows].join("\n");
  }
  const tags = docxSignalTags(item);
  let text = item.text.replace(/\n/g, "⏎");
  if (text.length > textCap) text = text.slice(0, textCap) + `…（段过长截断，全段 ${item.text.length} 字符）`;
  return `[¶${idx}${tags ? " " + tags : ""}] ${text}`;
}

// ─── pdf 行式渲染 ────────────────────────────────────────────────────────────

const PAGE_STATUS_LABEL: Record<PdfPage["status"], string> = {
  ok: "",
  blank: "空白页",
  rasterized: "栅格化页（无文本层，内容是图像——需 OCR/人工，不要当作没有内容）",
  "extract-incomplete": "抽取不完整（页内有文本绘制但未能提取——多为字体编码问题，不要当作空白页）",
};

function renderPdfPage(p: PdfPage, budget: { left: number; chars: number }): string[] {
  const head = `── p${p.n}${p.vertical ? "（竖排，行=列右→左，y=列顶/段差信号，⟨N⟩=间隙pt）" : ""}${p.status !== "ok" ? `：${PAGE_STATUS_LABEL[p.status]}` : ""} ──`;
  const out = [head];
  for (let i = 0; i < p.lines.length; i++) {
    if (budget.left <= 0 || budget.chars >= READ_CHAR_BUDGET) {
      out.push(`…（单次上限已满（行数/字符），从 p${p.n}.${i} 起分批续读）`);
      break;
    }
    const ln = p.lines[i];
    const tags = [
      `x=${ln.x}`,
      p.vertical ? `y=${ln.y}` : null,
      ln.font ? `字体:${ln.font}` : null,
      ln.boilerplate ? "≡重复" : null,
      ln.contNext ? "⤵续下页?" : null,
      ln.contPrev ? "⤴接上页?" : null,
    ].filter(Boolean).join(" ");
    let text = ln.text;
    if (text.length > READ_TEXT_CAP) text = text.slice(0, READ_TEXT_CAP) + "…";
    const line = `[p${p.n}.${i} ${tags}] ${text}`;
    out.push(line);
    budget.left--;
    budget.chars += line.length;
  }
  return out;
}

// ─── doc_outline ─────────────────────────────────────────────────────────────

export async function docOutline(userId: string, productionId: string, assetId: string, opts: DocToolOpts = {}): Promise<string> {
  const loaded = await loadDoc(userId, productionId, assetId, opts);
  if (typeof loaded === "string") return neutralizeInjectionTags(loaded); // 错误消息可含用户可控文件名/标题
  if (loaded.kind === "docx") return docxOutline(loaded.doc, loaded.fileName);
  return pdfOutline(loaded.doc, loaded.fileName);
}

function fmtHist<K>(m: Map<K, number>, cap = 12): string {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap)
    .map(([k, c]) => `${String(k)}×${c}`).join("、") || "（无）";
}

function docxOutline(doc: DocxDoc, fileName: string): string {
  if (doc.items.length === 0)
    return neutralizeInjectionTags(`《${fileName}》解析成功但没有任何内容块（空文档或纯图形文档）。`);

  const styleHist = new Map<string, number>();
  const alignHist = new Map<string, number>();
  const indentHist = new Map<number, number>();
  const fontHist = new Map<string, number>();
  let bFull = 0, iFull = 0, uFull = 0;
  for (const it of doc.items) {
    if (it.kind !== "p") continue;
    styleHist.set(it.style ?? "(无样式)", (styleHist.get(it.style ?? "(无样式)") ?? 0) + 1);
    alignHist.set(it.align ?? "(默认)", (alignHist.get(it.align ?? "(默认)") ?? 0) + 1);
    if (it.indent != null) {
      const b = Math.round(it.indent / INDENT_BUCKET) * INDENT_BUCKET;
      indentHist.set(b, (indentHist.get(b) ?? 0) + 1);
    }
    if (it.font) fontHist.set(it.font, (fontHist.get(it.font) ?? 0) + 1);
    if (it.flags?.includes("b")) bFull++;
    if (it.flags?.includes("i")) iFull++;
    if (it.flags?.includes("u")) uFull++;
  }

  const lines: string[] = [];
  lines.push(`《${fileName}》docx 结构概览（块号 ¶0-¶${doc.items.length - 1}，供 doc_read/doc_search 引用）`);
  lines.push(`总量：段落 ${doc.stats.paragraphs}、表格 ${doc.stats.tables}、非文本对象 ${doc.stats.objects}、脚注/尾注 ${doc.stats.footnotes}`);
  lines.push(`主字体：${doc.stats.majorityFont ?? "（未声明）"}；主字号：${doc.stats.majoritySz ?? "（未声明）"}（各段仅在偏离主流时标注 字体:/sz=）`);
  lines.push(`样式直方图：${fmtHist(styleHist)}`);
  lines.push(`对齐直方图：${fmtHist(alignHist)}`);
  lines.push(`缩进聚类（桶宽 ${INDENT_BUCKET} twips）：${fmtHist(indentHist)}`);
  if (fontHist.size) lines.push(`非主流字体段：${fmtHist(fontHist)}`);
  lines.push(`整段格式计数：粗体 ${bFull}、斜体 ${iFull}、下划线 ${uFull}`);
  lines.push("");
  lines.push(`开头 ${Math.min(OUTLINE_PREVIEW_COUNT, doc.items.length)} 块预览：`);
  for (let i = 0; i < Math.min(OUTLINE_PREVIEW_COUNT, doc.items.length); i++) {
    lines.push(renderDocxItem(i, doc.items[i], 80));
  }
  return neutralizeInjectionTags(lines.join("\n"));
}

/** 逐页行数分带 + run-length 压缩（Curtains 类"一个文件两本书"的宏观分界一眼可见）。 */
function densityBands(pages: PdfPage[]): string {
  const band = (p: PdfPage): string => {
    if (p.status !== "ok") return p.status === "blank" ? "空白" : p.status === "rasterized" ? "栅格" : "抽取不完整";
    const n = p.lines.length;
    return n <= 8 ? "稀(≤8行)" : n <= 60 ? "常规" : "密(>60行，可能是谱面音节/表格)";
  };
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i <= pages.length; i++) {
    if (i === pages.length || band(pages[i]) !== band(pages[start])) {
      const label = band(pages[start]);
      parts.push(start === i - 1 ? `p${pages[start].n}:${label}` : `p${pages[start].n}-${pages[i - 1].n}:${label}`);
      start = i;
    }
  }
  return parts.join("、");
}

function pdfOutline(doc: PdfDoc, fileName: string): string {
  const lines: string[] = [];
  const s = doc.stats;
  lines.push(`《${fileName}》pdf 结构概览（页序 p1-p${s.pageCount}，行锚 pN.i，供 doc_read/doc_search 引用；印刷页码可能≠页序）`);
  lines.push(`页数 ${s.pageCount}（竖排 ${s.verticalPages}、空白 ${s.blankPages}、栅格化 ${s.rasterizedPages}、抽取不完整 ${s.incompletePages}）`);
  if (!s.assetsAvailable)
    lines.push("⚠ 服务端 cMaps 字体资源缺失——CJK 文档会整页抽取不完整，这是环境问题不是文档问题。");
  if (s.rasterizedPages > 0)
    lines.push("⚠ 存在栅格化页：那些页的内容是图像，文本工具读不到（≠没有内容）——用 production.doc_page_ocr 按页识别文字（识别结果可能有错字，关键处问用户核对）。");
  lines.push(`逐页密度带：${densityBands(doc.pages)}`);

  // 横排页的 x 聚类（缩进 lane 直方图）
  const xHist = new Map<number, number>();
  let iCount = 0;
  for (const p of doc.pages) {
    if (p.vertical || p.status !== "ok") continue;
    for (const ln of p.lines) {
      if (ln.boilerplate) continue;
      xHist.set(Math.round(ln.x / PDF_X_BUCKET) * PDF_X_BUCKET, (xHist.get(Math.round(ln.x / PDF_X_BUCKET) * PDF_X_BUCKET) ?? 0) + 1);
      iCount++;
    }
  }
  if (iCount) lines.push(`横排行首 x 聚类（桶宽 ${PDF_X_BUCKET}pt，共 ${iCount} 行）：${fmtHist(xHist)}`);
  if (Object.keys(doc.fontLegend).length) {
    const legend = Object.entries(doc.fontLegend).map(([k, v]) => `${k}=${v}${k === doc.majorityFont ? "（主）" : ""}`).join("、");
    lines.push(`字体图例：${legend}（各行仅在偏离主字体时标注）`);
  }
  if (doc.boilerplate.length) {
    lines.push(`跨页重复行（水印/页眉脚，行上已标 ≡）：${doc.boilerplate.slice(0, 6).map((t) => JSON.stringify(t.slice(0, 40))).join("、")}${doc.boilerplate.length > 6 ? ` 等 ${doc.boilerplate.length} 条` : ""}`);
  }

  const firstContent = doc.pages.find((p) => p.lines.length > 0);
  if (firstContent) {
    lines.push("");
    lines.push(`首个有文本的页（p${firstContent.n}）预览：`);
    lines.push(...renderPdfPage(firstContent, { left: 25, chars: 0 }));
  } else {
    lines.push("全文档没有可抽取的文本行。");
  }
  return neutralizeInjectionTags(lines.join("\n"));
}

// ─── doc_read ────────────────────────────────────────────────────────────────

export async function docRead(
  userId: string, productionId: string, assetId: string,
  ranges: Array<{ from: number; to: number }>,
  opts: DocToolOpts = {},
): Promise<string> {
  const loaded = await loadDoc(userId, productionId, assetId, opts);
  if (typeof loaded === "string") return neutralizeInjectionTags(loaded); // 错误消息可含用户可控文件名/标题
  if (!ranges.length) return "ranges 不能为空（docx 例：[{from:0,to:40}]（块号）；pdf 例：[{from:1,to:5}]（页序））。";
  if (loaded.kind === "docx") return docxRead(loaded.doc, ranges);
  return pdfRead(loaded.doc, ranges);
}

function docxRead(doc: DocxDoc, ranges: Array<{ from: number; to: number }>): string {
  const last = doc.items.length - 1;
  const lines: string[] = [];
  let chars = 0;
  const notesWanted = new Set<string>();
  const rendered = new Set<number>(); // 重叠区间去重：同一块只渲染一次、只计一次 cap
  for (const r of ranges) {
    const from = Math.max(0, Math.floor(r.from));
    const to = Math.min(last, Math.floor(r.to));
    if (from > to) { lines.push(`（范围 ${r.from}-${r.to} 无效或越界，文档块号 0-${last}）`); continue; }
    for (let i = from; i <= to; i++) {
      if (rendered.has(i)) continue;
      if (rendered.size >= READ_ITEM_CAP || chars >= READ_CHAR_BUDGET) {
        lines.push(`…（单次上限已满：${READ_ITEM_CAP} 块 / ${READ_CHAR_BUDGET} 字符，从 ¶${i} 起分批续读）`);
        return neutralizeInjectionTags(lines.join("\n"));
      }
      const it = doc.items[i];
      const line = renderDocxItem(i, it, READ_TEXT_CAP);
      lines.push(line);
      chars += line.length;
      if (it.kind === "p") for (const id of it.footnotes ?? []) notesWanted.add(id);
      rendered.add(i);
    }
  }
  if (notesWanted.size) {
    lines.push("");
    lines.push("涉及的脚注/尾注：");
    for (const id of notesWanted) {
      const t = doc.footnotes[id];
      lines.push(`⟦${id.startsWith("e") ? "尾注" + id.slice(1) : "脚注" + id}⟧ ${t ?? "（未找到）"}`);
    }
  }
  return neutralizeInjectionTags(lines.join("\n"));
}

/** ⤵/⤴ 的无歧义说明——出现该标记的输出必附此行（用户点名要求说清）。 */
const CONT_LEGEND =
  "标记说明：⤵续下页? = 该行是本页末行且疑似句子未完（括号未闭合，或无句末标点且下页以小写续起）；" +
  "⤴接上页? = 该行疑似上一页 ⤵ 行的继续。两行很可能是**同一段被分页截断**——导入时应拼合为一块，" +
  "不要拆成两块（启发式判定，最终由你结合内容确认）。";

function pdfRead(doc: PdfDoc, ranges: Array<{ from: number; to: number }>): string {
  const lines: string[] = [];
  const rendered = new Set<number>();
  const lineBudget = { left: READ_PDF_LINE_CAP, chars: 0 };
  const hasCont = ranges.some((r) => {
    const from = Math.max(1, Math.floor(r.from)), to = Math.min(doc.stats.pageCount, Math.floor(r.to));
    for (let n = from; n <= to; n++) {
      if (doc.pages[n - 1]?.lines.some((l) => l.contNext || l.contPrev)) return true;
    }
    return false;
  });
  if (hasCont) lines.push(CONT_LEGEND);
  for (const r of ranges) {
    const from = Math.max(1, Math.floor(r.from));
    const to = Math.min(doc.stats.pageCount, Math.floor(r.to));
    if (from > to) { lines.push(`（范围 ${r.from}-${r.to} 无效或越界，页序 1-${doc.stats.pageCount}）`); continue; }
    for (let n = from; n <= to; n++) {
      if (rendered.has(n)) continue;
      if (rendered.size >= READ_PDF_PAGE_CAP || lineBudget.left <= 0 || lineBudget.chars >= READ_CHAR_BUDGET) {
        lines.push(`…（单次上限已满：${READ_PDF_PAGE_CAP} 页 / ${READ_PDF_LINE_CAP} 行，从 p${n} 起分批续读）`);
        return neutralizeInjectionTags(lines.join("\n"));
      }
      lines.push(...renderPdfPage(doc.pages[n - 1], lineBudget));
      rendered.add(n);
    }
  }
  return neutralizeInjectionTags(lines.join("\n"));
}

// ─── doc_search ──────────────────────────────────────────────────────────────

export async function docSearch(
  userId: string, productionId: string, assetId: string,
  opts: { query: string; limit?: number } & DocToolOpts,
): Promise<string> {
  const loaded = await loadDoc(userId, productionId, assetId, opts);
  if (typeof loaded === "string") return neutralizeInjectionTags(loaded); // 错误消息可含用户可控文件名/标题
  const q = opts.query.trim();
  if (!q) return "搜索词不能为空。";
  const limit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, opts.limit ?? SEARCH_DEFAULT_LIMIT));
  const qLower = q.toLowerCase();

  const hits: string[] = [];
  let total = 0;
  const push = (label: string, text: string) => {
    total++;
    if (hits.length >= limit) return;
    const at = text.toLowerCase().indexOf(qLower);
    const ctx = text.slice(Math.max(0, at - 40), at + q.length + 60).replace(/\n/g, "⏎");
    hits.push(`${label} …${ctx}…`);
  };

  if (loaded.kind === "docx") {
    const doc = loaded.doc;
    for (let i = 0; i < doc.items.length; i++) {
      const it = doc.items[i];
      if (it.kind === "p") {
        if (it.text.toLowerCase().includes(qLower)) push(`[¶${i}]`, it.text);
      } else {
        const flat = it.rows.map((r) => r.join(" | ")).join("\n");
        if (flat.toLowerCase().includes(qLower)) push(`[¶${i} 表格]`, flat);
      }
    }
    for (const [id, t] of Object.entries(doc.footnotes)) {
      if (t.toLowerCase().includes(qLower)) push(`[脚注${id}]`, t);
    }
  } else {
    for (const p of loaded.doc.pages) {
      for (let i = 0; i < p.lines.length; i++) {
        if (p.lines[i].text.toLowerCase().includes(qLower)) push(`[p${p.n}.${i}]`, p.lines[i].text);
      }
    }
  }
  if (total === 0) return `没有找到「${neutralizeInjectionTags(q)}」。`;
  const head = total > limit ? `命中 ${total} 处（显示前 ${limit} 处，可加 limit 或缩小词）：` : `命中 ${total} 处：`;
  return neutralizeInjectionTags([head, ...hits].join("\n"));
}

// ─── doc_page_ocr（#453：MMP 接入首例）───────────────────────────────────────
// 栅格化 / 抽取不完整的页文本层读不到，按页交给 MMP 的 ocr.structured：快档
// （PP-OCR 文本行 + 每页质量信号）先跑，某页 flags 非空再对那些页提慢档（版面
// 结构 + markdown + 表格 / 印章元素）。升不升档由模型决定，服务不自动升。
// - 权限 = asset meta face（与 doc_* 同门，能预览即能识别）；
// - 媒体走 R2 预签名 URL（算力节点在别的网络，只有公网 URL 拉得到）；
// - OCR 输出是不可信文本（用户文件），统一过 neutralizeInjectionTags；识别可能有错字，
//   输出里明说，关键处让模型问用户核对；
// - 计费：GPU 推理毫秒折 credit（lib/mmp/usage-db.ts，#618），缓存命中不记。

const OCR_MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  tif: "image/tiff", tiff: "image/tiff", webp: "image/webp",
};
const OCR_PAGE_CAP: Record<OcrTier, number> = { "gpu-fast": READ_PDF_PAGE_CAP, gpu: 5 };
/** 预签名有效期：要盖住排队 + 冷启动 + 单次任务，15 分钟够。 */
const OCR_URL_TTL_SEC = 15 * 60;
const OCR_TIER_LABEL: Record<OcrTier, string> = { "gpu-fast": "快档", gpu: "慢档（版面结构）" };

export type DocPageOcrOpts = DocToolOpts & { tier?: "fast" | "full"; signal?: AbortSignal };

export async function docPageOcr(
  userId: string, productionId: string, assetId: string,
  pages: number[],
  opts: DocPageOcrOpts = {},
): Promise<string> {
  const got = await resolveReadableAsset(userId, productionId, assetId);
  if (typeof got === "string") return neutralizeInjectionTags(got);
  const { asset, file } = got;
  const name = asset.fileName ?? "";
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const mime = OCR_MIME_BY_EXT[ext] ?? (asset.mimeType && Object.values(OCR_MIME_BY_EXT).includes(asset.mimeType) ? asset.mimeType : null);
  if (!mime) return neutralizeInjectionTags(`该资产（${name || "无文件名"}）不是 pdf / png / jpeg / tiff / webp，无法做 OCR。`);

  const tier: OcrTier = opts.tier === "full" ? "gpu" : "gpu-fast";
  let wanted = [...new Set(pages.map((p) => Math.floor(p)).filter((p) => Number.isFinite(p) && p >= 1))].sort((a, b) => a - b);
  if (!wanted.length) return "pages 不能为空（1 起的页序，例：[3, 4]；图片文件用 [1]）。";

  // pdf 已解析过的话拿页状态：有文本层的页提醒用 doc_read（便宜且无错字），越界页裁掉
  const textLayerPages = new Set<number>();
  let pageCount: number | null = null;
  let imageNote = "";
  if (mime === "application/pdf") {
    const parsed = await loadParsedPdf(
      { fileId: file.id, r2Key: file.r2Key, fileSize: file.fileSize, fileName: name },
      { notifySessionId: opts.sessionId ?? null },
    ).catch(() => null);
    if (parsed?.status === "ok") {
      pageCount = parsed.doc.stats.pageCount;
      wanted = wanted.filter((p) => p <= pageCount!);
      if (!wanted.length) return `页序越界：该 pdf 共 ${pageCount} 页。`;
      for (const p of wanted) if (parsed.doc.pages[p - 1]?.status === "ok") textLayerPages.add(p);
    }
  } else if (wanted.length !== 1 || wanted[0] !== 1) {
    // 图片文件只有一页：多页请求不静默裁，回话里说明
    wanted = [1];
    imageNote = "（图片文件只有 1 页，pages 按 [1] 处理）";
  }
  const cap = OCR_PAGE_CAP[tier];
  const truncated = wanted.length > cap ? wanted.slice(cap) : [];
  if (truncated.length) wanted = wanted.slice(0, cap);

  const url = presignedGet(file.r2Key, OCR_URL_TTL_SEC, { contentType: mime });
  const out = await ocrPages({ fileId: file.id, url, pages: wanted, tier }, { signal: opts.signal });
  if (out.status === "error") {
    if (out.unavailable) {
      return `⚠ OCR 服务当前不可用（${out.code}）：本次没有识别到任何内容，不要把这当作页面为空。` +
        "可以稍后重试；如果用户急用，请他提供文本版或口述关键内容。";
    }
    return neutralizeInjectionTags(`OCR 请求失败（${out.code}）：${out.message}`);
  }

  // 记账失败不吞成「0 credit」：结果照常返回（推理已经花了），文案如实说没记上。
  // 与 chat 侧 recordUsage 同款只打日志——系统性记账失败的告警是 #618 复核账本时看的。
  let billingNote: string;
  if (out.cached) {
    billingNote = "，缓存命中不计费";
  } else {
    const credits = await recordMmpUsage({
      userId, productionId, type: "ocr.structured", tier: out.tier, computeMs: out.computeMs,
    }).catch((e) => { console.error("[doc_page_ocr] 记账失败（结果照常返回）:", e); return null; });
    billingNote = credits === null
      ? "，本次用量记账失败（已记日志）"
      : `，本次约 ${credits.toLocaleString("zh-CN")} credit${out.computeEstimated ? "（估算）" : ""}`;
  }

  const lines: string[] = [];
  lines.push(
    `《${name}》OCR（${OCR_TIER_LABEL[out.tier]}，引擎 ${out.engine || "?"}，${out.pages.length} 页${billingNote}）${imageNote}。` +
    "识别文本可能有错字 / 漏行，关键处要让用户核对。",
  );
  const budget = { chars: 0 };
  for (const p of out.pages) lines.push(...renderOcrPage(p, textLayerPages.has(p.page), budget));
  if (budget.chars >= READ_CHAR_BUDGET) lines.push("…（单次字符上限已满，其余页分批再识别）");
  if (truncated.length) lines.push(`（单次最多 ${cap} 页，未处理：p${truncated.join(", p")}——分批续跑）`);
  if (out.tier === "gpu-fast" && out.suggestUpgradePages.length) {
    lines.push(`建议升慢档的页（质量信号异常）：p${out.suggestUpgradePages.join(", p")}——用 tier: "full" 只对这些页重跑，能拿到版面结构与更稳的识别。`);
  }
  return neutralizeInjectionTags(lines.join("\n"));
}

const OCR_FLAG_LABEL: Record<string, string> = {
  low_confidence: "低置信行偏多",
  coverage_anomaly: "有字没被认出（覆盖率低）",
  empty: "没认出文字",
};

function renderOcrPage(p: OcrPage, hasTextLayer: boolean, budget: { chars: number }): string[] {
  const q = p.quality;
  const meta = [
    `行=${q.lines}`,
    typeof q.mean_score === "number" ? `置信=${q.mean_score.toFixed(2)}` : null,
    p.flags.length ? `⚠ ${p.flags.map((f) => OCR_FLAG_LABEL[f] ?? f).join("、")}` : null,
  ].filter(Boolean).join(" ");
  const out = [`── p${p.page} [OCR ${meta}]${hasTextLayer ? "（该页有文本层，doc_read 可直接读，OCR 仅作核对）" : ""} ──`];
  if (budget.chars >= READ_CHAR_BUDGET) return out;
  let body = p.tier === "gpu" && p.markdown ? p.markdown : p.text;
  if (!body.trim()) body = "（本页没有识别到文字）";
  const room = READ_CHAR_BUDGET - budget.chars;
  if (body.length > room) body = body.slice(0, room) + "…";
  out.push(body);
  budget.chars += body.length;
  if (p.tier === "gpu" && p.elements?.length) {
    const counts = new Map<string, number>();
    for (const e of p.elements) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    out.push(`版面元素：${[...counts].map(([t, n]) => `${t}×${n}`).join("、")}`);
  }
  return out;
}
