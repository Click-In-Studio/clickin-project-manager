// #47 文档理解查询通道——agent 三工具（production.doc_outline / doc_read / doc_search）。
//
// 定位：让 agent 能"读懂"上传的剧本类文档（先 docx；pdf 挂下一弹），配合指示
// skill 的分诊协议做 AI 辅助导入。设计定谳（四标本实测，见 #47 / 记忆）：
// - outline=建地图不灌正文：直方图（样式/对齐/缩进聚类/字体）+ 开头抽样，
//   AI 据此提"三大块映射假设"（角色名/对白/舞台指示），不预设任何排版惯例
//   ——all caps 是英文惯例，中文本常用居中或换字体（信号词表通用、映射每文档）；
// - read=紧凑行式标注 `[¶N 信号] 文本`，段落号是引用锚点；批量数组参数；
// - search=先定位再精读（search-then-read 比线性扫便宜一个量级）；
// - 文档内容是不可信文本：输出统一过 neutralizeInjectionTags；
// - 权限口径＝asset meta face（与 preview-url 同门：能预览即能读内容）。

import { resolveProductionActor, DENIED_NOT_MEMBER } from "./production-tools";
import { neutralizeInjectionTags } from "@/lib/agent-injection-safety";
import { getAsset, resolveAssetFile } from "@/lib/asset/db";
import { canViewAsset } from "@/lib/asset/perm";
import { r2ByteSource, TransientReadError } from "@/lib/asset/byte-source";
import {
  getDocxCached, DocxParseError,
  type DocxDoc, type DocxItem, type DocxParagraph,
} from "@/lib/doc-extract/docx";

export const DENIED_ASSET_VIEW = "权限被拒绝：你没有查看该资产的权限。";
const TRANSIENT_MSG = "文件读取暂时失败（存储层瞬态错误），请稍后重试。";

/** doc_read 单次调用最多返回的块数（超出让模型分批——长文档本来就该分段精读）。 */
const READ_ITEM_CAP = 150;
/** 单段文本上限（保上下文预算；超长段截断并标注，模型可按 ¶ 号用更小范围重读）。 */
const READ_TEXT_CAP = 1200;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const OUTLINE_PREVIEW_COUNT = 12;
/** 缩进聚类桶宽（twips）。缩进值常带浮点碎片（Google Docs 导出），聚类后才可读。 */
const INDENT_BUCKET = 120;

// ─── 装载（权限门 + 格式分派）───────────────────────────────────────────────

async function loadDoc(
  userId: string, productionId: string, assetId: string,
): Promise<{ doc: DocxDoc; fileName: string } | string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== productionId) return "没有找到该资产。";
  if (!await canViewAsset(resolved.actor, productionId, asset, "meta")) return DENIED_ASSET_VIEW;

  const name = asset.fileName ?? "";
  const lower = name.toLowerCase();
  if (lower.endsWith(".doc"))
    return "老式 .doc（二进制格式）不支持解析——请把文件另存为 .docx 后重新上传。";
  if (lower.endsWith(".pdf"))
    return "pdf 解析通道尚未上线（在计划中）。目前只支持 .docx。";
  if (!lower.endsWith(".docx"))
    return `该资产（${name || "无文件名"}）不是 .docx 文档，暂不支持解析。`;
  if (asset.storageType !== "r2") return "该资产不是本站存储的文件（如飞书链接），无法解析。";

  const file = await resolveAssetFile(assetId);
  if (!file?.r2Key) return "该资产没有可读的文件内容。";
  const r2Key = file.r2Key;
  try {
    const doc = await getDocxCached(file.id, () => r2ByteSource(r2Key, file.fileSize));
    return { doc, fileName: name };
  } catch (e) {
    if (e instanceof TransientReadError) return TRANSIENT_MSG;
    if (e instanceof DocxParseError) return `docx 解析失败：${e.message}`;
    throw e;
  }
}

// ─── 行式渲染（信号只报不判——块级解读是模型的事）────────────────────────────

function signalTags(p: DocxParagraph): string {
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

function renderItem(idx: number, item: DocxItem, textCap: number): string {
  if (item.kind === "table") {
    const cols = item.rows[0]?.length ?? 0;
    const head = `[¶${idx} 表格 ${item.rows.length}×${cols}${item.truncated ? " 截断" : ""}]`;
    const rows = item.rows.slice(0, 20).map((r) => "  " + r.join(" | "));
    if (item.rows.length > 20) rows.push(`  …（共 ${item.rows.length} 行，用更小范围或按需另读）`);
    return [head, ...rows].join("\n");
  }
  const tags = signalTags(item);
  let text = item.text.replace(/\n/g, "⏎");
  if (text.length > textCap) text = text.slice(0, textCap) + `…（段过长截断，全段 ${item.text.length} 字符）`;
  return `[¶${idx}${tags ? " " + tags : ""}] ${text}`;
}

// ─── doc_outline ─────────────────────────────────────────────────────────────

export async function docOutline(userId: string, productionId: string, assetId: string): Promise<string> {
  const loaded = await loadDoc(userId, productionId, assetId);
  if (typeof loaded === "string") return loaded;
  const { doc, fileName } = loaded;
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
  const fmt = <K,>(m: Map<K, number>, cap = 12) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap)
      .map(([k, c]) => `${String(k)}×${c}`).join("、") || "（无）";

  const lines: string[] = [];
  lines.push(`《${fileName}》docx 结构概览（块号 ¶0-¶${doc.items.length - 1}，供 doc_read/doc_search 引用）`);
  lines.push(`总量：段落 ${doc.stats.paragraphs}、表格 ${doc.stats.tables}、非文本对象 ${doc.stats.objects}、脚注/尾注 ${doc.stats.footnotes}`);
  lines.push(`主字体：${doc.stats.majorityFont ?? "（未声明）"}；主字号：${doc.stats.majoritySz ?? "（未声明）"}（各段仅在偏离主流时标注 字体:/sz=）`);
  lines.push(`样式直方图：${fmt(styleHist)}`);
  lines.push(`对齐直方图：${fmt(alignHist)}`);
  lines.push(`缩进聚类（桶宽 ${INDENT_BUCKET} twips）：${fmt(indentHist)}`);
  if (fontHist.size) lines.push(`非主流字体段：${fmt(fontHist)}`);
  lines.push(`整段格式计数：粗体 ${bFull}、斜体 ${iFull}、下划线 ${uFull}`);
  lines.push("");
  lines.push(`开头 ${Math.min(OUTLINE_PREVIEW_COUNT, doc.items.length)} 块预览：`);
  for (let i = 0; i < Math.min(OUTLINE_PREVIEW_COUNT, doc.items.length); i++) {
    lines.push(renderItem(i, doc.items[i], 80));
  }
  return neutralizeInjectionTags(lines.join("\n"));
}

// ─── doc_read ────────────────────────────────────────────────────────────────

export async function docRead(
  userId: string, productionId: string, assetId: string,
  ranges: Array<{ from: number; to: number }>,
): Promise<string> {
  const loaded = await loadDoc(userId, productionId, assetId);
  if (typeof loaded === "string") return loaded;
  const { doc } = loaded;
  if (!ranges.length) return "ranges 不能为空（例：[{from: 0, to: 40}]）。";

  const last = doc.items.length - 1;
  const lines: string[] = [];
  const notesWanted = new Set<string>();
  const rendered = new Set<number>(); // 重叠区间去重：同一块只渲染一次、只计一次 cap
  for (const r of ranges) {
    const from = Math.max(0, Math.floor(r.from));
    const to = Math.min(last, Math.floor(r.to));
    if (from > to) { lines.push(`（范围 ${r.from}-${r.to} 无效或越界，文档块号 0-${last}）`); continue; }
    for (let i = from; i <= to; i++) {
      if (rendered.has(i)) continue;
      if (rendered.size >= READ_ITEM_CAP) {
        lines.push(`…（单次上限 ${READ_ITEM_CAP} 块已满，从 ¶${i} 起分批续读）`);
        return neutralizeInjectionTags(lines.join("\n"));
      }
      const it = doc.items[i];
      lines.push(renderItem(i, it, READ_TEXT_CAP));
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

// ─── doc_search ──────────────────────────────────────────────────────────────

export async function docSearch(
  userId: string, productionId: string, assetId: string,
  opts: { query: string; limit?: number },
): Promise<string> {
  const loaded = await loadDoc(userId, productionId, assetId);
  if (typeof loaded === "string") return loaded;
  const { doc } = loaded;
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
  if (total === 0) return `没有找到「${neutralizeInjectionTags(q)}」。`;
  const head = total > limit ? `命中 ${total} 处（显示前 ${limit} 处，可加 limit 或缩小词）：` : `命中 ${total} 处：`;
  return neutralizeInjectionTags([head, ...hits].join("\n"));
}
