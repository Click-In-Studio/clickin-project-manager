import { presignedGet } from "../r2";

/**
 * 字节源抽象（#85 元数据基建）：分析器按 (offset, length) 拉字节，不感知底下是
 * R2 Range GET 还是内存 Buffer。Range 的价值不在账单（R2 egress 免费、Class B
 * 读 ~$0.36/百万次）而在**不把 GB 级文件整个拉进 Node 内存**——一次分析发几个
 * Range 请求完全不心疼，不必为省请求数把分析器写复杂。
 */
export interface ByteSource {
  /** 总字节数；未知（存量 asset_file.file_size 为 NULL）为 null。 */
  size: number | null;
  /** 读 [offset, offset+length)。越过文件末尾时截断，返回实际读到的字节。 */
  read(offset: number, length: number): Promise<Buffer>;
}

/** 预算超限：确定性结果（同一文件同一分析器永远超），落盘 status="oversized" 不再重试。 */
export class ByteBudgetExceededError extends Error {
  constructor(msg: string) { super(msg); this.name = "ByteBudgetExceededError"; }
}

/** 底层读失败（网络/R2 瞬态）：非确定性，调用方**不得**把它落盘成 failed。 */
export class TransientReadError extends Error {
  constructor(msg: string, cause?: unknown) { super(msg, { cause }); this.name = "TransientReadError"; }
}

/** 护栏预算：防分析器 bug 或恶意构造文件把服务器拖死，不是省钱手段。 */
export const DEFAULT_BUDGET = { maxBytes: 1024 * 1024, maxReads: 8 };

export function withBudget(
  src: ByteSource,
  budget: { maxBytes: number; maxReads: number } = DEFAULT_BUDGET,
): ByteSource {
  let bytesUsed = 0;
  let reads = 0;
  return {
    size: src.size,
    async read(offset, length) {
      reads += 1;
      bytesUsed += length;
      if (reads > budget.maxReads)
        throw new ByteBudgetExceededError(`read budget exceeded: ${reads} > ${budget.maxReads} reads`);
      if (bytesUsed > budget.maxBytes)
        throw new ByteBudgetExceededError(`byte budget exceeded: ${bytesUsed} > ${budget.maxBytes} bytes`);
      return src.read(offset, length);
    },
  };
}

/**
 * R2 Range 实现。不走 getR2Stream（它把非 2xx 一律抛成异常，区分不了确定性
 * 与瞬态）——字节源必须自持状态语义：
 * - 416（整段越过文件末尾，如 0 字节文件读 head、存量 size NULL 行的尾读）
 *   ＝确定性「读到 0 字节」，与截断语义一致，让信封能落成终态而不是永远重试；
 * - 404（对象没了）＝异常态但**刻意不落终态**：对象缺失多半是 #428 回收漏洞
 *   类问题，不该把 failed 固化到文件行上（下载/预览同样是坏的，修复后元数据
 *   应立即可算）。代价是每次详情多一个 404 的 Range 请求，可忽略；
 * - 网络错误 / 5xx ＝瞬态，上抛 TransientReadError，调用方不落盘。
 */
export function r2ByteSource(r2Key: string, size: number | null): ByteSource {
  return {
    size,
    async read(offset, length) {
      // size 已知时本地钳制省一次注定 416 的请求；未知时靠下面的 416 分支兜底
      if (size != null) length = Math.min(length, Math.max(0, size - offset));
      if (length <= 0) return Buffer.alloc(0);
      let res: Response;
      try {
        res = await fetch(presignedGet(r2Key), {
          headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        });
      } catch (e) {
        throw new TransientReadError(`R2 range read failed (${r2Key})`, e);
      }
      if (res.status === 416) return Buffer.alloc(0);
      if (res.status === 404) throw new TransientReadError(`R2 object missing (${r2Key})`);
      if (!res.ok && res.status !== 206)
        throw new TransientReadError(`R2 range read got ${res.status} (${r2Key})`);
      const buf = Buffer.from(await res.arrayBuffer());
      // 万一服务端忽略 Range 回了 200 全量，本地切片兜底，不让全文件漏进分析器
      if (res.status === 200 && buf.length > length) return buf.subarray(offset, offset + length);
      return buf.subarray(0, length);
    },
  };
}

/** 内存实现（测试与小文件路径用）。 */
export function bufferByteSource(buf: Buffer): ByteSource {
  return {
    size: buf.length,
    async read(offset, length) {
      return buf.subarray(Math.min(offset, buf.length), Math.min(offset + length, buf.length));
    },
  };
}
