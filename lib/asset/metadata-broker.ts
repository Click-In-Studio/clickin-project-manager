import type { ByteSource } from "./byte-source";
import { pngParser, wavParser, flacParser, mp3Parser, isobmffParser, zipParser } from "./metadata-parsers";

/**
 * 类型 broker（#85）：决定一个文件「是什么」并分发给对应的元数据分析器。
 * 判定顺序定谳：**magic bytes 主判 → 扩展名破同门 → mime 声明只做最后参考**。
 * 扩展名破同门不是备胎是刚需：docx/xlsx/pptx 全是 zip magic，压缩包容器类
 * 只能靠扩展名区分。客户端声明的 mime 不可信，永远排最后。
 *
 * 【版本契约】改 magic 表/扩展名表/新增分析器 ⇒ bump BROKER_VERSION（让存量
 * unsupported 信封重走 broker）；升级某个分析器 ⇒ bump 它自己的 version（只有
 * 它命中过的信封重算）。忘 bump = 存量永不重算，这是唯一的失效通道。
 *
 * 版本史：1=#433 基建+PNG 样板；2=PR1 媒体/压缩标量批（wav/flac/mp3/bmff/zip）
 * + RF64 magic。
 */
export const BROKER_VERSION = 2;

/** 分析器读满 head（含 magic 判型所需前缀）之外的字节自己按需 Range。 */
export const SNIFF_HEAD_LENGTH = 4096;

export interface MetadataParser {
  key: string;
  version: number;
  /** 预算覆盖（如 mp4 的 box 走位要更多 Range 次数）；缺省用 DEFAULT_BUDGET。 */
  budget?: { maxBytes: number; maxReads: number };
  /** head 是文件前 SNIFF_HEAD_LENGTH 字节（短文件更短），够用就别再发请求。 */
  parse(src: ByteSource, head: Buffer): Promise<Record<string, unknown>>;
}

function ext(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i < 0 ? "" : fileName.slice(i + 1).toLowerCase();
}

function has(head: Buffer, offset: number, sig: string | number[]): boolean {
  const bytes = typeof sig === "string" ? [...sig].map((c) => c.charCodeAt(0)) : sig;
  if (head.length < offset + bytes.length) return false;
  return bytes.every((b, i) => head[offset + i] === b);
}

/** zip 容器同门：magic 全是 PK，靠扩展名分家。 */
const ZIP_BY_EXT: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** EBML 同门（webm/mkv）。 */
const EBML_BY_EXT: Record<string, string> = { webm: "video/webm", mkv: "video/x-matroska" };

/**
 * magic 判型。认不出返回 null（不回落 mime 声明——认不出就是认不出，声明值
 * 单独展示，两边不混）。
 */
export function sniffDetectedType(head: Buffer, fileName: string): string | null {
  const e = ext(fileName);

  if (has(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (has(head, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (has(head, 0, "GIF87a") || has(head, 0, "GIF89a")) return "image/gif";
  if (has(head, 0, [0x49, 0x49, 0x2a, 0x00]) || has(head, 0, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";

  if (has(head, 0, "RIFF")) {
    if (has(head, 8, "WEBP")) return "image/webp";
    if (has(head, 8, "WAVE")) return "audio/wav";
    if (has(head, 8, "AVI ")) return "video/x-msvideo";
    return null;
  }
  // RF64（EBU 3306，>4GB 的 BWF/ADM 交付常见形态）：布局同 RIFF、真实尺寸在 ds64
  if (has(head, 0, "RF64") && has(head, 8, "WAVE")) return "audio/wav";

  if (has(head, 0, "%PDF-")) return "application/pdf";

  // zip 家族：常规/空档案/spanned 三种局部头
  if (has(head, 0, "PK") && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07))
    return ZIP_BY_EXT[e] ?? "application/zip";
  if (has(head, 0, "Rar!")) return "application/vnd.rar";
  if (has(head, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "application/x-7z-compressed";
  if (has(head, 0, [0x1f, 0x8b])) return "application/gzip";

  if (has(head, 0, "fLaC")) return "audio/flac";
  if (has(head, 0, "OggS")) return "audio/ogg";
  if (has(head, 0, "ID3")) return "audio/mpeg";
  // 裸 mp3 帧头：FF Ex/Fx（MPEG sync）。放宽到常见位形，避免吃掉别的格式所以放在具体 magic 之后
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (has(head, 0, "MThd")) return "audio/midi";
  if (has(head, 0, "FORM") && (has(head, 8, "AIFF") || has(head, 8, "AIFC"))) return "audio/aiff";

  // ISO BMFF（mp4 家族）：magic 在 offset 4
  if (has(head, 4, "ftyp")) {
    const brand = head.subarray(8, 12).toString("latin1");
    if (brand.startsWith("M4A")) return "audio/mp4";
    if (brand.startsWith("qt")) return "video/quicktime";
    return "video/mp4";
  }
  if (has(head, 0, [0x1a, 0x45, 0xdf, 0xa3])) return EBML_BY_EXT[e] ?? "video/webm";

  return null;
}

// ─── 分析器注册表 ─────────────────────────────────────────────────────────────
// 按 detectedType 精确分发（一个 parser 可挂多个类型键，如 isobmff 通吃
// mp4/m4a/mov）。各分析器的 data shape 归自己私有，基建不定词表；新格式
// （pdf 页数/工程文件…）按格式单开 PR 往这里挂，互不阻塞。分析器本体在
// lib/asset/metadata-parsers.ts。

const PARSERS: ReadonlyMap<string, MetadataParser> = new Map([
  ["image/png", pngParser],
  ["audio/wav", wavParser],
  ["audio/flac", flacParser],
  ["audio/mpeg", mp3Parser],
  ["audio/mp4", isobmffParser],
  ["video/mp4", isobmffParser],
  ["video/quicktime", isobmffParser],
  ["application/zip", zipParser],
]);

export function resolveParser(detectedType: string | null): MetadataParser | null {
  return detectedType ? (PARSERS.get(detectedType) ?? null) : null;
}

/** 按 parser 自己的 key 查（信封里存的是 parser.key，不是注册表的类型键）。 */
export function parserByKey(key: string): MetadataParser | null {
  for (const p of PARSERS.values()) if (p.key === key) return p;
  return null;
}
