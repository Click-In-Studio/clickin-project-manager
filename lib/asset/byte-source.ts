import { getR2Stream } from "../r2";

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

/** R2 Range 实现。length=0 直接短路（Range 头不能表达空区间）。 */
export function r2ByteSource(r2Key: string, size: number | null): ByteSource {
  return {
    size,
    async read(offset, length) {
      // 越界截断在本地做：R2 对整段越界回 416，而 getR2Stream 会把非 2xx 抛成
      // 异常，到不了这层。size 未知（存量 NULL 行）时钳不了，靠分析器只读头部
      // 的习惯兜着。
      if (size != null) length = Math.min(length, Math.max(0, size - offset));
      if (length <= 0) return Buffer.alloc(0);
      let res: Response | null;
      try {
        res = await getR2Stream(r2Key, `bytes=${offset}-${offset + length - 1}`);
      } catch (e) {
        throw new TransientReadError(`R2 range read failed (${r2Key})`, e);
      }
      if (!res) throw new TransientReadError(`R2 object missing (${r2Key})`);
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
