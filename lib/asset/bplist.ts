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

/** 大端无符号整数，size 1-8 逐字节累加（trailer 的 size 不要求是 2 的幂，
 *  size=7 也合法；>8 或超安全整数一律抛错，不静默截断）。 */
function readUIntBE(buf: Buffer, off: number, size: number): number {
  if (size < 1 || size > 8) throw new Error(`bplist unsupported int width ${size}`);
  if (off < 0 || off + size > buf.length) throw new Error("bplist int out of range");
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[off + i];
  if (v > Number.MAX_SAFE_INTEGER) throw new Error("bplist int exceeds safe integer");
  return v;
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

    // 声明长度先对剩余字节验界再用——不给「单对象声明天文长度」绕过
    // MAX_OBJECTS 护栏直接触发大分配的机会
    const checkLen = (p: number, bytes: number) => {
      if (bytes < 0 || p + bytes > buf.length - 32) throw new Error("bplist declared length out of range");
    };

    if (marker === 0x00) v = null;
    else if (marker === 0x08) v = false;
    else if (marker === 0x09) v = true;
    // int 对象的宽容语义（严格护栏只留给结构性整数：长度/偏移/引用走 readUIntBE）：
    // 8 字节按规范有符号（-1 存 0xFF…）、16 字节（UUID/哈希类，真 qlab 文件实测
    // 存在）取值有损转 Number——值我们不消费，拒绝会让整个工程解析失败
    else if (high === 0x10) {
      const size = 1 << (marker & 0x0f);
      if (pos + size > buf.length) throw new Error("bplist int out of range");
      if (size === 8) v = Number(buf.readBigInt64BE(pos));
      else if (size === 16) v = Number((buf.readBigUInt64BE(pos) << BigInt(64)) | buf.readBigUInt64BE(pos + 8));
      else v = readUIntBE(buf, pos, size);
    }
    else if (high === 0x20) { const size = 1 << (marker & 0x0f); v = size === 4 ? buf.readFloatBE(pos) : buf.readDoubleBE(pos); }
    else if (marker === 0x33) v = buf.readDoubleBE(pos); // date：2001 纪元秒
    else if (high === 0x40) { const { len, pos: p } = readLength(marker, pos); checkLen(p, len); v = buf.subarray(p, p + len); }
    else if (high === 0x50) { const { len, pos: p } = readLength(marker, pos); checkLen(p, len); v = buf.toString("latin1", p, p + len); }
    // utf16-BE：局部复制再 swap，不原地改调用方的字节
    else if (high === 0x60) { const { len, pos: p } = readLength(marker, pos); checkLen(p, len * 2); v = Buffer.from(buf.subarray(p, p + len * 2)).swap16().toString("utf16le"); }
    else if (high === 0x80) { const size = (marker & 0x0f) + 1; v = new BplistUID(readUIntBE(buf, pos, size)); }
    else if (high === 0xa0 || high === 0xc0) { // array / set
      const { len, pos: p } = readLength(marker, pos);
      checkLen(p, len * refSize);
      const arr: BplistValue[] = new Array(len);
      for (let i = 0; i < len; i++) arr[i] = obj(readUIntBE(buf, p + i * refSize, refSize));
      v = arr;
    } else if (high === 0xd0) { // dict：keys 引用连排 + values 引用连排
      const { len, pos: p } = readLength(marker, pos);
      checkLen(p, len * 2 * refSize);
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
