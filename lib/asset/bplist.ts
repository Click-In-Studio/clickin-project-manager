/**
 * Apple binary plist（bplist00）只读解析器（#85 PR3，qlab 工程用）。零依赖。
 *
 * 两种引用要分清：数组/字典的**结构引用**（offset 表下标）在这里急切解析成真值
 * ——plist 结构本身是树（带环护栏防恶意构造）；0x8n 的 **CF$UID** 是
 * NSKeyedArchiver 语义（指向 $objects 数组下标），保留为 BplistUID 由调用方
 * 解引用。
 *
 * 结构：8B 头 + 对象区 + offset 表 + 32B trailer（offsetSize/objectRefSize/
 * numObjects/topObject/offsetTableOffset，均大端）。
 */

export class BplistUID {
  constructor(public readonly id: number) {}
}

export type BplistValue =
  | null | boolean | number | string | Buffer | BplistUID
  | BplistValue[] | Map<BplistValue, BplistValue>;

const MAX_OBJECTS = 500_000; // 护栏：对象数轰炸

function readUIntBE(buf: Buffer, off: number, size: number): number {
  if (size <= 6) return buf.readUIntBE(off, size);
  return Number(buf.readBigUInt64BE(off + size - 8));
}

export function parseBplist(buf: Buffer): { objects: BplistValue[]; top: BplistValue } {
  if (buf.length < 40 || buf.toString("latin1", 0, 8) !== "bplist00")
    throw new Error("not a bplist00");
  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer[6];
  const refSize = trailer[7];
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topIndex = Number(trailer.readBigUInt64BE(16));
  const tableOffset = Number(trailer.readBigUInt64BE(24));
  if (numObjects <= 0 || numObjects > MAX_OBJECTS) throw new Error(`bplist object count out of range: ${numObjects}`);
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) throw new Error("bplist invalid trailer");
  if (tableOffset + numObjects * offsetSize > buf.length - 32) throw new Error("bplist offset table out of range");

  const offsets: number[] = new Array(numObjects);
  for (let i = 0; i < numObjects; i++)
    offsets[i] = readUIntBE(buf, tableOffset + i * offsetSize, offsetSize);

  /** 变长长度：低 nibble 0xF ⇒ 后随一个 int 对象承载真实长度。 */
  function readLength(marker: number, pos: number): { len: number; pos: number } {
    const low = marker & 0x0f;
    if (low !== 0x0f) return { len: low, pos };
    const intMarker = buf[pos];
    if ((intMarker & 0xf0) !== 0x10) throw new Error("bplist bad extended length");
    const size = 1 << (intMarker & 0x0f);
    return { len: readUIntBE(buf, pos + 1, size), pos: pos + 1 + size };
  }

  const memo: (BplistValue | undefined)[] = new Array(numObjects);
  const done: boolean[] = new Array(numObjects).fill(false);
  const inProgress = new Set<number>();

  function obj(idx: number): BplistValue {
    if (idx < 0 || idx >= numObjects) throw new Error("bplist ref out of range");
    if (done[idx]) return memo[idx]!;
    if (inProgress.has(idx)) throw new Error("bplist structural cycle");
    inProgress.add(idx);

    const start = offsets[idx];
    if (start < 8 || start >= buf.length - 32) throw new Error("bplist object offset out of range");
    const marker = buf[start];
    const high = marker & 0xf0;
    const pos = start + 1;
    let v: BplistValue;

    if (marker === 0x00) v = null;
    else if (marker === 0x08) v = false;
    else if (marker === 0x09) v = true;
    else if (high === 0x10) { const size = 1 << (marker & 0x0f); v = readUIntBE(buf, pos, size); }
    else if (high === 0x20) { const size = 1 << (marker & 0x0f); v = size === 4 ? buf.readFloatBE(pos) : buf.readDoubleBE(pos); }
    else if (marker === 0x33) v = buf.readDoubleBE(pos); // date：2001 纪元秒
    else if (high === 0x40) { const { len, pos: p } = readLength(marker, pos); v = buf.subarray(p, p + len); }
    else if (high === 0x50) { const { len, pos: p } = readLength(marker, pos); v = buf.toString("latin1", p, p + len); }
    // utf16-BE：局部复制再 swap，不原地改调用方的字节
    else if (high === 0x60) { const { len, pos: p } = readLength(marker, pos); v = Buffer.from(buf.subarray(p, p + len * 2)).swap16().toString("utf16le"); }
    else if (high === 0x80) { const size = (marker & 0x0f) + 1; v = new BplistUID(readUIntBE(buf, pos, size)); }
    else if (high === 0xa0 || high === 0xc0) { // array / set
      const { len, pos: p } = readLength(marker, pos);
      const arr: BplistValue[] = new Array(len);
      for (let i = 0; i < len; i++) arr[i] = obj(readUIntBE(buf, p + i * refSize, refSize));
      v = arr;
    } else if (high === 0xd0) { // dict：keys 引用连排 + values 引用连排
      const { len, pos: p } = readLength(marker, pos);
      const m = new Map<BplistValue, BplistValue>();
      for (let i = 0; i < len; i++) {
        m.set(
          obj(readUIntBE(buf, p + i * refSize, refSize)),
          obj(readUIntBE(buf, p + (len + i) * refSize, refSize)),
        );
      }
      v = m;
    } else {
      throw new Error(`bplist unknown marker 0x${marker.toString(16)}`);
    }

    inProgress.delete(idx);
    memo[idx] = v;
    done[idx] = true;
    return v;
  }

  const top = obj(topIndex);
  // 其余对象也物化（keyed archive 靠 $objects 数组寻址，通常都从 top 可达；
  // 不可达的孤儿对象不解析，省时且避免坏对象拖垮整体）
  return { objects: memo as BplistValue[], top };
}

/** 字符串键取值（plist 字典键解析后基本都是字符串）。 */
export function mget(m: BplistValue, key: string): BplistValue | undefined {
  if (!(m instanceof Map)) return undefined;
  for (const [k, v] of m) if (k === key) return v;
  return undefined;
}
