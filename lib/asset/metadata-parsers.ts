import { ByteBudgetExceededError, type ByteSource } from "./byte-source";
import type { MetadataParser } from "./metadata-broker";

/**
 * PR1 分析器集合（#85 路线图）：媒体标量 + 压缩标量。全部只产出「文件自己的
 * 确定性属性」标量进信封；清单/ADM XML 等大块头是 PR2 sidecar 的活，这里不碰。
 * 主要消费方是 AI（agent 面读元数据做判断），字段求机器可读与诚实标注
 * （estimated: true）胜过展示美观；人看媒体有在线预览兜着。
 */

/** head 覆盖不到的偏移再发 Range，覆盖得到的白拿（省预算里的 read 次数）。 */
async function readAt(src: ByteSource, head: Buffer, offset: number, length: number): Promise<Buffer> {
  if (offset >= 0 && offset + length <= head.length) return head.subarray(offset, offset + length);
  return src.read(offset, length);
}

// ─── PNG（#433 的管线样板，从 broker 移入）──────────────────────────────────

export const pngParser: MetadataParser = {
  key: "image/png",
  version: 1,
  async parse(_src, head) {
    // 8 字节签名 + IHDR chunk（4 长度 + 4 "IHDR" + 13 数据）
    if (head.length < 33 || head.toString("latin1", 12, 16) !== "IHDR") throw new Error("PNG IHDR missing");
    return {
      width: head.readUInt32BE(16),
      height: head.readUInt32BE(20),
      bitDepth: head[24],
    };
  },
};

// ─── WAV / BWF / RF64 ────────────────────────────────────────────────────────

/**
 * RIFF chunk 走位。BWF 的 bext/axml 常在 data 之后（按声明尺寸跳过 data，
 * 不读音频本体）；RF64（>4GB 的 ADM 交付常见）真实尺寸在 ds64 chunk。
 * 本期只报 axml 的存在与体量，完整 ADM XML 归 PR2 sidecar。
 */
export const wavParser: MetadataParser = {
  key: "audio/wav",
  version: 1,
  budget: { maxBytes: 256 * 1024, maxReads: 16 },
  async parse(src, head) {
    let byteRate = 0, sampleRate = 0, channels = 0, bitDepth = 0;
    let dataSize: number | null = null;
    let ds64DataSize: number | null = null;
    let isBwf = false, admXmlBytes = 0;

    let off = 12;
    for (let i = 0; i < 40; i++) {
      const hdr = await readAt(src, head, off, 8);
      if (hdr.length < 8) break;
      const id = hdr.toString("latin1", 0, 4);
      const rawSize = hdr.readUInt32LE(4);
      // RF64：本 chunk 真实尺寸被投到 ds64（约定只有 data 会溢出）
      const size = rawSize === 0xffffffff && ds64DataSize != null ? ds64DataSize : rawSize;

      if (id === "ds64") {
        const c = await readAt(src, head, off + 8, 16);
        if (c.length >= 16) ds64DataSize = Number(c.readBigUInt64LE(8));
      } else if (id === "fmt ") {
        const c = await readAt(src, head, off + 8, 16);
        if (c.length >= 16) {
          channels = c.readUInt16LE(2);
          sampleRate = c.readUInt32LE(4);
          byteRate = c.readUInt32LE(8);
          bitDepth = c.readUInt16LE(14);
        }
      } else if (id === "data") {
        // 哨兵未被 ds64 解开（破损/截断的 RF64）＝尺寸未知，诚实置 null，
        // 不许把 0xffffffff 当真字节数算出假时长
        dataSize = size < 0xffffffff ? size : null;
      } else if (id === "bext") {
        isBwf = true;
      } else if (id === "axml") {
        admXmlBytes = size < 0xffffffff ? size : 0;
      }
      if (size >= 0xffffffff) break; // 尺寸仍未知（无 ds64 的破损 RF64），不盲走
      off += 8 + size + (size % 2); // RIFF chunk 按偶数对齐
    }

    if (sampleRate === 0) throw new Error("WAV fmt chunk missing");
    return {
      durationSeconds: dataSize != null && byteRate > 0 ? dataSize / byteRate : null,
      sampleRate, channels, bitDepth, isBwf,
      ...(admXmlBytes > 0 && { admXmlBytes }),
    };
  },
};

// ─── FLAC ────────────────────────────────────────────────────────────────────

/** STREAMINFO 是首个 metadata block、定长 34 字节，纯 head 解析。 */
export const flacParser: MetadataParser = {
  key: "audio/flac",
  version: 1,
  async parse(_src, head) {
    // 4 签名 + block 头 4（type 低 7 位 =0 即 STREAMINFO）+ 34 数据
    if (head.length < 42 || (head[4] & 0x7f) !== 0) throw new Error("FLAC STREAMINFO missing");
    const s = head.subarray(8);
    const sampleRate = (s[10] << 12) | (s[11] << 4) | (s[12] >> 4);
    const channels = ((s[12] >> 1) & 0x07) + 1;
    const bitDepth = (((s[12] & 0x01) << 4) | (s[13] >> 4)) + 1;
    // 36 位总样本数；0 = 编码器未写（时长未知）
    const totalSamples = (s[13] & 0x0f) * 2 ** 32 + s.readUInt32BE(14);
    if (sampleRate === 0) throw new Error("FLAC invalid sample rate");
    return {
      durationSeconds: totalSamples > 0 ? totalSamples / sampleRate : null,
      sampleRate, channels, bitDepth,
    };
  },
};

// ─── MP3 ─────────────────────────────────────────────────────────────────────

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_SAMPLERATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000],  // MPEG2.5
};

/**
 * 时长策略（诚实标注定谳）：VBR 靠首帧 Xing/VBRI 帧计数精确；CBR 用
 * (文件大小-标签)/码率估算并标 estimated: true——ID3 尾部标签、封面等会让
 * 估值偏大几秒，AI 消费方自行斟酌，别当精确值用。
 */
export const mp3Parser: MetadataParser = {
  key: "audio/mpeg",
  version: 1,
  async parse(src, head) {
    // 跳 ID3v2（大封面常把首帧顶出 head 之外）
    let audioStart = 0;
    if (head.toString("latin1", 0, 3) === "ID3" && head.length >= 10) {
      const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
      audioStart = 10 + size + ((head[5] & 0x10) ? 10 : 0);
    }
    const win = await readAt(src, head, audioStart, 4096);

    // 找帧同步（容忍标签后的少量填充）
    let f = -1;
    for (let i = 0; i + 4 <= win.length && i < 2048; i++) {
      if (win[i] === 0xff && (win[i + 1] & 0xe0) === 0xe0 && ((win[i + 1] >> 1) & 0x03) === 0x01) { f = i; break; }
    }
    if (f < 0) throw new Error("MP3 frame sync not found");

    const versionBits = (win[f + 1] >> 3) & 0x03; // 3=MPEG1 2=MPEG2 0=MPEG2.5
    const bitrateIdx = win[f + 2] >> 4;
    const srIdx = (win[f + 2] >> 2) & 0x03;
    const channelMode = win[f + 3] >> 6;
    const sampleRate = MP3_SAMPLERATES[versionBits]?.[srIdx];
    const bitrateKbps = (versionBits === 3 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIdx];
    if (!sampleRate || !bitrateKbps) throw new Error("MP3 invalid frame header");
    const mono = channelMode === 3;
    const samplesPerFrame = versionBits === 3 ? 1152 : 576;

    // Xing/Info 紧跟 side info（帧内定偏移）
    const sideInfo = versionBits === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const x = f + 4 + sideInfo;
    const tag = win.toString("latin1", x, x + 4);
    if ((tag === "Xing" || tag === "Info") && win.length >= x + 12 && (win.readUInt32BE(x + 4) & 0x1)) {
      const frames = win.readUInt32BE(x + 8);
      return {
        durationSeconds: (frames * samplesPerFrame) / sampleRate,
        estimated: false, vbr: tag === "Xing",
        sampleRate, channels: mono ? 1 : 2,
        ...(tag === "Info" && { bitrateKbps }),
      };
    }
    return {
      durationSeconds: src.size != null ? ((src.size - audioStart) * 8) / (bitrateKbps * 1000) : null,
      estimated: true, vbr: false, bitrateKbps, sampleRate, channels: mono ? 1 : 2,
    };
  },
};

// ─── ISO BMFF（mp4/m4a/mov 一族共用）────────────────────────────────────────

/** moov 里按需解析的两块：mvhd（时长）与各 trak 的 tkhd（视频轨尺寸）。 */
function parseMoov(win: Buffer, moovSize: number): { durationSeconds: number | null; width?: number; height?: number } {
  let duration: number | null = null;
  let width = 0, height = 0;

  const walk = (start: number, end: number, depth: number) => {
    let off = start;
    for (let i = 0; i < 64 && off + 8 <= end; i++) {
      const size = win.readUInt32BE(off);
      const type = win.toString("latin1", off + 4, off + 8);
      if (size < 8) break;
      const body = off + 8;
      if (type === "mvhd" && body + 4 <= end) {
        const v = win[body];
        if (v === 0 && body + 20 <= end) duration = win.readUInt32BE(body + 16) / win.readUInt32BE(body + 12);
        else if (v === 1 && body + 32 <= end) duration = Number(win.readBigUInt64BE(body + 24)) / win.readUInt32BE(body + 20);
      } else if (type === "trak") {
        walk(body, Math.min(off + size, end), depth + 1);
      } else if (type === "tkhd" && body + 4 <= end) {
        const v = win[body];
        const dim = body + (v === 1 ? 88 : 76); // 16.16 定点 width/height
        if (dim + 8 <= end) {
          width = Math.max(width, win.readUInt32BE(dim) >> 16);
          height = Math.max(height, win.readUInt32BE(dim + 4) >> 16);
        }
      }
      off += size;
    }
  };
  walk(8, Math.min(moovSize, win.length), 0);
  return { durationSeconds: duration, ...(width > 0 && height > 0 && { width, height }) };
}

/**
 * 顶层 box 走位找 moov（非 faststart 文件在尾部，靠 Range 跳 mdat 不下载本体），
 * 命中后拉一个窗口本地解析。moov 超窗（超长视频的 stco 表）时 mvhd/tkhd
 * 通常仍在窗口前部，解析到多少算多少。
 */
export const isobmffParser: MetadataParser = {
  key: "isobmff",
  version: 1,
  budget: { maxBytes: 512 * 1024, maxReads: 16 },
  async parse(src, head) {
    const brand = head.toString("latin1", 8, 12).trim();
    let off = 0;
    for (let i = 0; i < 32; i++) {
      const hdr = await readAt(src, head, off, 16);
      if (hdr.length < 8) break;
      let size = hdr.readUInt32BE(0);
      const type = hdr.toString("latin1", 4, 8);
      if (size === 1) {
        if (hdr.length < 16) break;
        size = Number(hdr.readBigUInt64BE(8)); // largesize（>4GB 的 mdat）
      } else if (size === 0) {
        size = src.size != null ? src.size - off : 0; // box 到文件尾
      }
      if (type === "moov") {
        const win = await readAt(src, head, off, Math.min(size, 128 * 1024));
        return { brand, ...parseMoov(win, size) };
      }
      if (size < 8) break;
      off += size;
    }
    throw new Error("moov box not found");
  },
};

// ─── 打包类公约 entry 形状（zip/rar 共用，PR3 包内取文件与 QC 比对的消费面）──
// { path, uncompressedBytes, compressedBytes, mtime?, isDirectory, crc32?,
//   method?, offset, encrypted?, encodingGuessed? }
// offset+method 是刻意为 PR3 埋的：按 offset Range 取 entry 不用重读目录。

/** 清单条数上限（超大档案截断并标 truncated: true，诚实标注定式）。 */
export const ARCHIVE_ENTRY_CAP = 5000;

/** DOS 日期时间 → 无时区裸字符串（DOS 时间本就没有时区，不硬编 Z 假装 UTC）。 */
function dosDateTime(mdate: number, mtime: number): string | null {
  if (mdate === 0) return null;
  const y = 1980 + (mdate >> 9), mo = (mdate >> 5) & 0xf, d = mdate & 0x1f;
  if (mo < 1 || mo > 12 || d < 1) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(mtime >> 11)}:${p((mtime >> 5) & 0x3f)}:${p((mtime & 0x1f) * 2)}`;
}

let gbkDecoder: TextDecoder | null | undefined;

/** zip 文件名解码：UTF-8 flag（bit 11）可信；没置位官方是 cp437，但国内
 *  Windows 压的 zip 实际是 GBK ⇒ 非 ASCII 时按 GBK 猜并标 encodingGuessed。 */
function decodeZipName(raw: Buffer, utf8Flag: boolean): { path: string; guessed: boolean } {
  if (utf8Flag) return { path: raw.toString("utf8"), guessed: false };
  if (raw.every((b) => b < 0x80)) return { path: raw.toString("latin1"), guessed: false };
  if (gbkDecoder === undefined) {
    try { gbkDecoder = new TextDecoder("gbk"); } catch { gbkDecoder = null; }
  }
  if (gbkDecoder) {
    try { return { path: gbkDecoder.decode(raw), guessed: true }; } catch { /* fallthrough */ }
  }
  return { path: raw.toString("latin1"), guessed: true };
}

// ─── ZIP（EOCD 标量 + central directory 清单）───────────────────────────────

const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * central directory 连续存放（EOCD 给 offset+size），1-2 个 Range 整块拿下
 * ——这是 zip 与 rar 的本质区别（rar 无中央目录只能逐块走）。CD 超 4MB 只读
 * 前段并截断。
 */
export const zipParser: MetadataParser = {
  key: "application/zip",
  version: 2, // v2：EOCD 标量 → +central directory 清单（#85 PR2）
  budget: { maxBytes: 5 * 1024 * 1024, maxReads: 8 },
  async parse(src) {
    // EOCD 只能从尾部定位；存量 file_size NULL 行定位不了 ⇒ 确定性 failed
    if (src.size == null) throw new Error("file size unknown; cannot locate EOCD");
    // EOCD 定长 22 + 最长 64KB 注释：先试 4KB，不中再扩
    let tailLen = Math.min(src.size, 4096);
    let tail = await src.read(src.size - tailLen, tailLen);
    let idx = tail.lastIndexOf(EOCD_SIG);
    if (idx < 0 && src.size > tailLen) {
      tailLen = Math.min(src.size, 22 + 65535);
      tail = await src.read(src.size - tailLen, tailLen);
      idx = tail.lastIndexOf(EOCD_SIG);
    }
    if (idx < 0 || idx + 22 > tail.length) throw new Error("EOCD not found");

    let entryCount: number = tail.readUInt16LE(idx + 10);
    let cdSize = tail.readUInt32LE(idx + 12);
    let cdOffset = tail.readUInt32LE(idx + 16);
    let zip64 = false;
    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // zip64：EOCD 前是 20 字节 locator，指向 zip64 EOCD
      const loc = idx - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64Off = Number(tail.readBigUInt64LE(loc + 8));
        const z64 = await src.read(z64Off, 56);
        if (z64.length >= 56 && z64.readUInt32LE(0) === 0x06064b50) {
          entryCount = Number(z64.readBigUInt64LE(32));
          cdSize = Number(z64.readBigUInt64LE(40));
          cdOffset = Number(z64.readBigUInt64LE(48));
          zip64 = true;
        }
      }
    }

    const cdCap = Math.min(cdSize, 4 * 1024 * 1024);
    const cd = await src.read(cdOffset, cdCap);
    const entries: Record<string, unknown>[] = [];
    let truncated = cdCap < cdSize;
    let totalUncompressedBytes = 0;
    let off = 0;
    while (off + 46 <= cd.length && entries.length < ARCHIVE_ENTRY_CAP) {
      if (cd.readUInt32LE(off) !== 0x02014b50) break; // CD entry 签名
      const flags = cd.readUInt16LE(off + 8);
      const method = cd.readUInt16LE(off + 10);
      const mtime = dosDateTime(cd.readUInt16LE(off + 14), cd.readUInt16LE(off + 12));
      const crc32 = cd.readUInt32LE(off + 16);
      let compressedBytes = cd.readUInt32LE(off + 20);
      let uncompressedBytes = cd.readUInt32LE(off + 24);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      let offset = cd.readUInt32LE(off + 42);
      if (off + 46 + nameLen + extraLen > cd.length) { truncated = true; break; }
      const { path, guessed } = decodeZipName(cd.subarray(off + 46, off + 46 + nameLen), (flags & 0x800) !== 0);
      // zip64 extra（id 0x0001）：仅替换打了 0xffffffff 哨兵的字段，按序排列
      if (uncompressedBytes === 0xffffffff || compressedBytes === 0xffffffff || offset === 0xffffffff) {
        let eo = off + 46 + nameLen;
        const eEnd = eo + extraLen;
        while (eo + 4 <= eEnd) {
          const id = cd.readUInt16LE(eo), sz = cd.readUInt16LE(eo + 2);
          if (id === 0x0001) {
            let q = eo + 4;
            if (uncompressedBytes === 0xffffffff && q + 8 <= eEnd) { uncompressedBytes = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (compressedBytes === 0xffffffff && q + 8 <= eEnd) { compressedBytes = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (offset === 0xffffffff && q + 8 <= eEnd) { offset = Number(cd.readBigUInt64LE(q)); }
            break;
          }
          eo += 4 + sz;
        }
      }
      totalUncompressedBytes += uncompressedBytes;
      entries.push({
        path, uncompressedBytes, compressedBytes, isDirectory: path.endsWith("/"),
        crc32, method, offset,
        ...(mtime && { mtime }),
        ...((flags & 0x1) !== 0 && { encrypted: true }),
        ...(guessed && { encodingGuessed: true }),
      });
      off += 46 + nameLen + extraLen + commentLen;
    }
    if (entries.length >= ARCHIVE_ENTRY_CAP && entryCount > entries.length) truncated = true;
    return {
      entryCount, totalUncompressedBytes, entries,
      ...(truncated && { truncated: true }),
      ...(zip64 && { zip64: true }),
    };
  },
};

// ─── RAR5（无中央目录：逐块走位，接受截断）──────────────────────────────────

/** RAR5 vint：小端 base-128，高位是续位。 */
function readVint(buf: Buffer, off: number): { value: number; next: number } | null {
  let v = 0, shift = 0;
  for (let i = 0; i < 10; i++) {
    if (off + i >= buf.length) return null;
    const b = buf[off + i];
    v += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value: v, next: off + i + 1 };
    shift += 7;
  }
  return null;
}

const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const RAR4_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);

/**
 * 文件头与数据交错、下一跳偏移在上一个头里 ⇒ 串行 Range 不可并行，每跳读
 * 64KB 窗口（小文件密集时一窗多头）。maxReads 64 封顶，超预算收已走到的
 * 部分清单 + truncated——一次性成本，信封永久缓存。文件名 RAR5 规范强制
 * UTF-8，无 zip 的编码赌博。
 *
 * rar4 缓议（2026-09-06 拍板）：明确 throw → failed 终态，将来支持时 bump
 * version 自动重算存量。
 */
export const rarParser: MetadataParser = {
  key: "application/vnd.rar",
  version: 1,
  budget: { maxBytes: 8 * 1024 * 1024, maxReads: 64 },
  async parse(src, head) {
    if (head.subarray(0, 7).equals(RAR4_SIG)) throw new Error("RAR4 archive not supported yet");
    if (!head.subarray(0, 8).equals(RAR5_SIG)) throw new Error("not a RAR5 archive");

    const entries: Record<string, unknown>[] = [];
    let truncated = false;
    let totalUncompressedBytes = 0;
    let pos = 8;
    const WINDOW = 64 * 1024;
    try {
      for (let i = 0; i < ARCHIVE_ENTRY_CAP * 2; i++) {
        if (entries.length >= ARCHIVE_ENTRY_CAP) { truncated = true; break; }
        // head 覆盖到的块头白拿（零 Range）；不够放一个块头才发窗口读
        let win = pos + 64 <= head.length ? head.subarray(pos) : await src.read(pos, WINDOW);
        if (win.length < 7) break; // EOF
        // 块：crc32(4) + headerSize(vint) + header 本体
        const hs = readVint(win, 4);
        if (!hs) break;
        const headerEnd = hs.next + hs.value;
        if (headerEnd > win.length) {
          win = await src.read(pos, headerEnd); // 超窗巨头（如超长文件名）单独补拉
          if (win.length < headerEnd) break;
        }
        let p = hs.next;
        const type = readVint(win, p); if (!type) break; p = type.next;
        const hflags = readVint(win, p); if (!hflags) break; p = hflags.next;
        let dataSize = 0;
        if (hflags.value & 0x1) { const e = readVint(win, p); if (!e) break; p = e.next; } // extra area size
        if (hflags.value & 0x2) { const d = readVint(win, p); if (!d) break; dataSize = d.value; p = d.next; }
        if (type.value === 5) break; // end of archive
        if (type.value === 4) throw new Error("encrypted RAR archive (headers unreadable)");
        if (type.value === 2 || type.value === 3) { // file / service 头同构，只收 file
          const ff = readVint(win, p); if (!ff) break; p = ff.next;
          const us = readVint(win, p); if (!us) break; p = us.next;
          const attr = readVint(win, p); if (!attr) break; p = attr.next;
          let mtime: string | undefined, crc32: number | undefined;
          if (ff.value & 0x2) { if (p + 4 > win.length) break; mtime = new Date(win.readUInt32LE(p) * 1000).toISOString(); p += 4; }
          if (ff.value & 0x4) { if (p + 4 > win.length) break; crc32 = win.readUInt32LE(p); p += 4; }
          const comp = readVint(win, p); if (!comp) break; p = comp.next;
          const hostOs = readVint(win, p); if (!hostOs) break; p = hostOs.next;
          const nl = readVint(win, p); if (!nl) break; p = nl.next;
          if (p + nl.value > win.length) break;
          const path = win.toString("utf8", p, p + nl.value);
          if (type.value === 2) {
            const unpacked = (ff.value & 0x8) !== 0 ? null : us.value; // bit 3=尺寸未知
            if (unpacked != null) totalUncompressedBytes += unpacked;
            entries.push({
              path, uncompressedBytes: unpacked, compressedBytes: dataSize,
              isDirectory: (ff.value & 0x1) !== 0,
              method: (comp.value >> 7) & 0x7, offset: pos + headerEnd,
              ...(mtime && { mtime }),
              ...(crc32 !== undefined && { crc32 }),
            });
          }
        }
        pos += headerEnd + dataSize;
      }
    } catch (e) {
      // 预算走完但已有部分清单：收部分 + truncated（比 oversized 终态有用得多）
      if (e instanceof ByteBudgetExceededError && entries.length > 0) truncated = true;
      else throw e;
    }
    return {
      entryCount: entries.length, totalUncompressedBytes, entries,
      ...(truncated && { truncated: true }),
    };
  },
};
