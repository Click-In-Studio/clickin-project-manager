import { getPool } from "../pg";
import { isR2Configured, putR2Object, getR2Object } from "../r2";
import type { AssetFile } from "./db";
import {
  type ByteSource, ByteBudgetExceededError, TransientReadError,
  withBudget, r2ByteSource,
} from "./byte-source";
import { BROKER_VERSION, SNIFF_HEAD_LENGTH, sniffDetectedType, resolveParser, parserByKey } from "./metadata-broker";

/**
 * 元数据信封（#85）。asset_file.metadata 列里存的永远是它，不是裸数据。
 *
 * - failed / unsupported / oversized 都是**确定性终态要落盘**：损坏文件不落盘
 *   ⇒ 每次打开详情都重拉重失败；重试的唯一通道是版本号落后（isEnvelopeStale）。
 * - detectedType（magic 判型）与 asset.mime_type（客户端声明）分离存放、不回写
 *   ——回写会丢「用户声明了什么」，展示层自己选用探测值（2026-09-06 拍板）。
 * - sidecarKey 预留：将来 zip 清单/工程文件轨道表这类大块头落 R2
 *   meta/<fileId>.json，信封里 data 置 null 只留指针。本期恒 null。
 */
export type MetadataStatus = "ok" | "failed" | "unsupported" | "oversized";

export interface MetadataEnvelope {
  status: MetadataStatus;
  brokerVersion: number;
  parserKey: string | null;
  parserVersion: number | null;
  detectedType: string | null;
  extractedAt: string;
  /** shape 归命中的分析器私有；要跨类型查询/排序时再 promote 到列（另开 issue）。 */
  data: Record<string, unknown> | null;
  sidecarKey: string | null;
  error: string | null;
}

/** 版本落后才重算：unsupported 看 brokerVersion（新分析器上线靠 bump 它触发重 broker），
 *  命中过分析器的看该分析器自己的 version。 */
export function isEnvelopeStale(env: MetadataEnvelope): boolean {
  if (env.brokerVersion < BROKER_VERSION) return true;
  if (env.parserKey) {
    const p = parserByKey(env.parserKey);
    if (p && (env.parserVersion ?? 0) < p.version) return true;
  }
  return false;
}

/**
 * 对字节源跑 broker + 分析器，产出信封。错误边界：
 * - 确定性失败（分析器抛错/预算超限）⇒ 落成 failed / oversized 信封；
 * - 瞬态失败（TransientReadError，R2 网络类）⇒ **原样上抛**，调用方不落盘，
 *   下次请求重试——把瞬态错误固化成 failed 会让好文件永远显示解析失败。
 */
export async function extractEnvelope(rawSrc: ByteSource, fileName: string): Promise<MetadataEnvelope> {
  const base = {
    brokerVersion: BROKER_VERSION,
    extractedAt: new Date().toISOString(),
    sidecarKey: null,
    error: null,
  };
  // sniff 头读定长（SNIFF_HEAD_LENGTH）自安全，不占预算；预算按命中的
  // 分析器配（per-parser 覆盖，如 bmff 的 box 走位要更多 Range 次数）
  const head = await rawSrc.read(0, SNIFF_HEAD_LENGTH); // 瞬态错误从这里直接上抛
  const detectedType = sniffDetectedType(head, fileName);
  const parser = resolveParser(detectedType);
  if (!parser) {
    return { ...base, status: "unsupported", parserKey: null, parserVersion: null, detectedType, data: null };
  }
  const src = withBudget(rawSrc, parser.budget);
  try {
    const data = await parser.parse(src, head);
    return { ...base, status: "ok", parserKey: parser.key, parserVersion: parser.version, detectedType, data };
  } catch (e) {
    if (e instanceof TransientReadError) throw e;
    const status: MetadataStatus = e instanceof ByteBudgetExceededError ? "oversized" : "failed";
    return {
      ...base, status, parserKey: parser.key, parserVersion: parser.version, detectedType,
      data: null, error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function setAssetFileMetadata(fileId: string, env: MetadataEnvelope): Promise<void> {
  await getPool().query(`UPDATE asset_file SET metadata = $2 WHERE id = $1`, [fileId, env]);
}

// ─── Sidecar（#85 PR2）───────────────────────────────────────────────────────
// 信封必须保持可控大小：asset_file 是 SELECT *，preview/thumb 每个请求都拖着
// metadata 列走，大清单塞 JSONB 等于给所有文件读路径加税。超阈值的 entries
// 落 R2，信封留指针 + 标量聚合。

export const SIDECAR_THRESHOLD_BYTES = 32 * 1024;

/** 可卸载到 sidecar 的大数组字段（清单/cue 树/track 表/引用表）。标量永远留信封。 */
const SIDECAR_LIST_FIELDS = ["entries", "cueLists", "tracks", "refs", "projects", "admObjects"] as const;

export function metadataSidecarKey(fileId: string): string {
  return `meta/${fileId}.json`;
}

/**
 * 落库前分离：data 序列化超阈值 ⇒ 大数组字段整组移入 sidecar payload、信封
 * data 只留标量并置 sidecarKey。key 按 fileId 确定性，版本 bump 重算就地覆盖，
 * 幂等。
 */
export function splitEnvelopeForStorage(
  env: MetadataEnvelope,
  fileId: string,
): { envelope: MetadataEnvelope; sidecar: Record<string, unknown> | null } {
  if (env.data == null) return { envelope: env, sidecar: null };
  const bigFields = SIDECAR_LIST_FIELDS.filter((f) => Array.isArray(env.data![f]));
  if (bigFields.length === 0) return { envelope: env, sidecar: null };
  if (Buffer.byteLength(JSON.stringify(env.data)) <= SIDECAR_THRESHOLD_BYTES)
    return { envelope: env, sidecar: null };
  const scalars = { ...env.data };
  const lists: Record<string, unknown> = {};
  for (const f of bigFields) {
    lists[f] = scalars[f];
    delete scalars[f];
  }
  return {
    envelope: { ...env, data: scalars, sidecarKey: metadataSidecarKey(fileId) },
    sidecar: { fileId, parserKey: env.parserKey, parserVersion: env.parserVersion, ...lists },
  };
}

/** 读面水合：信封带 sidecarKey 时拉回大数组字段拼进 data（?full=1 用）。
 *  sidecar 拉取失败按瞬态处理（调用方降级返回未水合信封）。 */
export async function hydrateMetadata(env: MetadataEnvelope): Promise<MetadataEnvelope> {
  if (!env.sidecarKey) return env;
  if (SIDECAR_LIST_FIELDS.some((f) => Array.isArray(env.data?.[f]))) return env; // 已内联
  let obj: Awaited<ReturnType<typeof getR2Object>>;
  try {
    obj = await getR2Object(env.sidecarKey);
  } catch (e) {
    throw new TransientReadError(`sidecar read failed (${env.sidecarKey})`, e);
  }
  if (!obj) return env; // 悬空指针（#428 回收类异常态）：降级回标量，不 500
  try {
    const sc = JSON.parse(obj.body.toString("utf8")) as Record<string, unknown>;
    const merged = { ...env.data };
    let any = false;
    for (const f of SIDECAR_LIST_FIELDS) {
      if (Array.isArray(sc[f])) { merged[f] = sc[f]; any = true; }
    }
    if (any) return { ...env, data: merged };
  } catch {
    // 损坏的 sidecar JSON：降级回标量
  }
  return env;
}

/**
 * 懒轨主入口（照 avatar-serve 定式）：有新鲜信封直接回，否则就地分析写回。
 * 存量文件第一次被看时自动补齐，无需回填脚本；并发重复分析是幂等覆盖，无害。
 * 上传路径零改动——没人看的文件永远不花钱。
 */
export async function getOrExtractFileMetadata(
  file: AssetFile,
  fileName: string,
): Promise<MetadataEnvelope | null> {
  if (!file.r2Key) return file.metadata;
  if (file.metadata && !isEnvelopeStale(file.metadata)) return file.metadata;
  // 本地无 R2 凭据（常见开发态）：不产生假 failed 落盘，回旧信封/空
  if (!isR2Configured()) return file.metadata;
  const raw = await extractEnvelope(r2ByteSource(file.r2Key, file.fileSize), fileName);
  const { envelope, sidecar } = splitEnvelopeForStorage(raw, file.id);
  if (sidecar) {
    // 顺序钉死：先 sidecar 后信封。孤儿 sidecar 无害（#428 回收类垃圾），
    // 信封指向不存在的 sidecar 才是 bug；写失败按瞬态不落盘，下次重试
    try {
      await putR2Object(metadataSidecarKey(file.id), Buffer.from(JSON.stringify(sidecar)), "application/json");
    } catch (e) {
      throw new TransientReadError(`sidecar write failed (${file.id})`, e);
    }
  }
  await setAssetFileMetadata(file.id, envelope);
  return envelope;
}
