import { describe, it, expect } from "vitest";
import { extractEnvelope } from "@/lib/asset/metadata";
import { sniffDetectedType, BROKER_VERSION } from "@/lib/asset/metadata-broker";
import { zipParser, rarParser, ARCHIVE_ENTRY_CAP } from "@/lib/asset/metadata-parsers";
import { bufferByteSource, withBudget } from "@/lib/asset/byte-source";

// PR1 分析器批：媒体标量（wav/flac/mp3/bmff）+ 压缩标量（zip EOCD）。
// fixture 全部手工构造最小合法字节，锚定各格式的偏移算术。

// ─── fixture 构造 ─────────────────────────────────────────────────────────────

function riffChunk(id: string, body: Buffer, declaredSize?: number): Buffer {
  const hdr = Buffer.alloc(8);
  hdr.write(id, 0, "latin1");
  hdr.writeUInt32LE(declaredSize ?? body.length, 4);
  return Buffer.concat([hdr, body]);
}

function wavFmt(channels: number, sampleRate: number, bitDepth: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(1, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(sampleRate, 4);
  b.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 8); // byteRate
  b.writeUInt16LE(channels * (bitDepth / 8), 12);
  b.writeUInt16LE(bitDepth, 14);
  return b;
}

function wavFile(magic: string, chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const hdr = Buffer.alloc(12);
  hdr.write(magic, 0, "latin1");
  hdr.writeUInt32LE(4 + body.length, 4);
  hdr.write("WAVE", 8, "latin1");
  return Buffer.concat([hdr, body]);
}

function flacFile(sampleRate: number, channels: number, bitDepth: number, totalSamples: number): Buffer {
  const s = Buffer.alloc(34);
  s[10] = sampleRate >> 12;
  s[11] = (sampleRate >> 4) & 0xff;
  s[12] = ((sampleRate & 0xf) << 4) | ((channels - 1) << 1) | ((bitDepth - 1) >> 4);
  s[13] = (((bitDepth - 1) & 0xf) << 4) | (Math.floor(totalSamples / 2 ** 32) & 0xf);
  s.writeUInt32BE(totalSamples % 2 ** 32, 14);
  return Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.from([0x80, 0, 0, 34]), s]);
}

/** MPEG1 Layer3 帧头：0xFF 0xFB + bitrateIdx/srIdx + 声道模式。 */
function mp3Frame(opts: { xingFrames?: number; infoTag?: boolean } = {}): Buffer {
  const b = Buffer.alloc(1044); // 一整帧（128kbps@44100 ≈ 417 字节）+ 余量
  b[0] = 0xff; b[1] = 0xfb;
  b[2] = 0x90; // bitrate idx 9=128kbps, samplerate idx 0=44100
  b[3] = 0x00; // stereo
  if (opts.xingFrames != null) {
    const x = 4 + 32; // MPEG1 立体声 side info 32 字节
    b.write(opts.infoTag ? "Info" : "Xing", x, "latin1");
    b.writeUInt32BE(0x1, x + 4); // flags: frames present
    b.writeUInt32BE(opts.xingFrames, x + 8);
  }
  return b;
}

function box(type: string, body: Buffer): Buffer {
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32BE(8 + body.length, 0);
  hdr.write(type, 4, "latin1");
  return Buffer.concat([hdr, body]);
}

function mp4File(): Buffer {
  const mvhdBody = Buffer.alloc(100);
  mvhdBody.writeUInt32BE(600, 12);  // timescale
  mvhdBody.writeUInt32BE(6000, 16); // duration → 10s
  const tkhdBody = Buffer.alloc(84);
  tkhdBody.writeUInt32BE(1920 << 16, 76); // 16.16 定点
  tkhdBody.writeUInt32BE(1080 << 16, 80);
  const moov = box("moov", Buffer.concat([box("mvhd", mvhdBody), box("trak", box("tkhd", tkhdBody))]));
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom", "latin1"), Buffer.alloc(4)]));
  const mdat = box("mdat", Buffer.alloc(50));
  return Buffer.concat([ftyp, mdat, moov]); // moov 在尾（非 faststart 常态）
}

function zipEocd(totalEntries: number, commentLen = 0): Buffer {
  const b = Buffer.alloc(22 + commentLen);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(totalEntries, 8);  // 本盘 entry 数
  b.writeUInt16LE(totalEntries, 10); // 总 entry 数
  b.writeUInt16LE(commentLen, 20);
  return b;
}

// ─── WAV / BWF / RF64 ────────────────────────────────────────────────────────

describe("wavParser", () => {
  it("标准 WAV：fmt + 声明尺寸的 data（不读音频本体）", async () => {
    const wav = wavFile("RIFF", [
      riffChunk("fmt ", wavFmt(2, 48000, 24)),
      riffChunk("data", Buffer.alloc(0), 2_880_000), // 只声明不附体
    ]);
    const env = await extractEnvelope(bufferByteSource(wav), "mix.wav");
    expect(env.status).toBe("ok");
    expect(env.parserKey).toBe("audio/wav");
    expect(env.data).toMatchObject({
      durationSeconds: 10, sampleRate: 48000, channels: 2, bitDepth: 24, isBwf: false,
    });
  });

  it("BWF：bext 置 isBwf，data 之后的 axml 按尺寸跳 data 找到", async () => {
    const wav = wavFile("RIFF", [
      riffChunk("fmt ", wavFmt(2, 48000, 24)),
      riffChunk("bext", Buffer.alloc(602)),
      riffChunk("data", Buffer.alloc(6)),
      riffChunk("axml", Buffer.alloc(100)),
    ]);
    const env = await extractEnvelope(bufferByteSource(wav), "adm.wav");
    expect(env.data).toMatchObject({ isBwf: true, admXmlBytes: 100 });
  });

  it("RF64：magic 判为 audio/wav，data 真实尺寸取自 ds64", async () => {
    const ds64 = Buffer.alloc(28);
    ds64.writeBigUInt64LE(BigInt(2_880_000_000), 8); // dataSize → 10000s
    const wav = wavFile("RF64", [
      riffChunk("ds64", ds64),
      riffChunk("fmt ", wavFmt(2, 48000, 24)),
      riffChunk("data", Buffer.alloc(0), 0xffffffff),
    ]);
    expect(sniffDetectedType(wav, "long-adm.wav")).toBe("audio/wav");
    const env = await extractEnvelope(bufferByteSource(wav), "long-adm.wav");
    expect(env.status).toBe("ok");
    expect(env.data?.durationSeconds).toBe(10000);
  });

  it("ADM：data 后的 axml 拉回解析结构面 + chna 计数 + dbmd 旁证（wav v2）", async () => {
    const admXml = `<?xml version="1.0"?><frame><audioFormatExtended>
<audioProgramme audioProgrammeID="APR_1001" audioProgrammeName="Atmos_Master" start="00:00:00.00000" end="00:01:34.12500"></audioProgramme>
<audioContent audioContentID="ACO_1001"></audioContent>
<audioObject audioObjectID="AO_1001" audioObjectName="Standard Bed 7.1.2" start="00:00:00.00000" duration="00:01:34.12500"></audioObject>
<audioObject audioObjectID="AO_1002" audioObjectName="harp &amp; strings (L)"></audioObject>
<audioPackFormat audioPackFormatID="AP_1001"></audioPackFormat>
<audioChannelFormat audioChannelFormatID="AC_1001"></audioChannelFormat>
<audioChannelFormat audioChannelFormatID="AC_1002"></audioChannelFormat>
<audioTrackUID UID="ATU_00000001"></audioTrackUID>
</audioFormatExtended></frame>`;
    const chna = Buffer.alloc(4 + 40);
    chna.writeUInt16LE(70, 0); // numTracks
    chna.writeUInt16LE(70, 2); // numUIDs
    const wav = wavFile("RIFF", [
      riffChunk("fmt ", wavFmt(2, 48000, 24)),
      riffChunk("data", Buffer.alloc(6)),
      riffChunk("axml", Buffer.from(admXml, "utf8")),
      riffChunk("chna", chna),
      riffChunk("dbmd", Buffer.alloc(8)),
    ]);
    const env = await extractEnvelope(bufferByteSource(wav), "atmos.wav");
    expect(env.status).toBe("ok");
    expect(env.data).toMatchObject({
      hasDbmd: true, chnaTracks: 70, chnaUids: 70,
      adm: {
        programmeCount: 1, contentCount: 1, objectCount: 2,
        packFormatCount: 1, channelFormatCount: 2, trackUidCount: 1,
        programmes: [{ name: "Atmos_Master", start: "00:00:00.00000", end: "00:01:34.12500" }],
      },
    });
    const objs = env.data?.admObjects as Record<string, unknown>[];
    expect(objs).toHaveLength(2);
    expect(objs[0]).toMatchObject({ name: "Standard Bed 7.1.2", duration: "00:01:34.12500" });
    expect(objs[1].name).toBe("harp & strings (L)"); // 实体解码
  });

  it("畸形 chna（声明尺寸 <4）不读——宁缺毋假，不把下个 chunk 头当计数", async () => {
    const wav = wavFile("RIFF", [
      riffChunk("fmt ", wavFmt(2, 48000, 24)),
      riffChunk("data", Buffer.alloc(6)),
      riffChunk("chna", Buffer.alloc(2)), // 只有 2 字节
      riffChunk("dbmd", Buffer.alloc(8)),
    ]);
    const env = await extractEnvelope(bufferByteSource(wav), "broken-chna.wav");
    expect(env.status).toBe("ok");
    expect(env.data?.chnaTracks).toBeUndefined();
    expect(env.data?.hasDbmd).toBe(true);
  });

  it("axml 超上限：只标 xmlOversized，不硬啃 keyframe 大户", async () => {
    const wav = wavFile("RIFF", [
      riffChunk("fmt ", wavFmt(2, 48000, 24)),
      riffChunk("data", Buffer.alloc(6)),
      riffChunk("axml", Buffer.alloc(0), 20 * 1024 * 1024), // 声明 20MB 不附体
    ]);
    const env = await extractEnvelope(bufferByteSource(wav), "huge-adm.wav");
    expect(env.status).toBe("ok");
    expect(env.data?.adm).toMatchObject({ xmlOversized: true });
    expect(env.data?.admXmlBytes).toBe(20 * 1024 * 1024);
    expect(env.data?.admObjects).toBeUndefined();
  });

  it("破损 RF64（哨兵尺寸但无 ds64）→ 时长诚实置 null，不把 0xffffffff 当字节数", async () => {
    const wav = wavFile("RF64", [
      riffChunk("fmt ", wavFmt(2, 48000, 24)),
      riffChunk("data", Buffer.alloc(0), 0xffffffff), // 无 ds64 chunk
    ]);
    const env = await extractEnvelope(bufferByteSource(wav), "corrupt-rf64.wav");
    expect(env.status).toBe("ok");
    expect(env.data?.durationSeconds).toBeNull();
    expect(env.data).toMatchObject({ sampleRate: 48000, channels: 2 });
  });
});

// ─── FLAC ────────────────────────────────────────────────────────────────────

describe("flacParser", () => {
  it("STREAMINFO 位打包解析", async () => {
    const env = await extractEnvelope(bufferByteSource(flacFile(44100, 2, 16, 441000)), "song.flac");
    expect(env.status).toBe("ok");
    expect(env.data).toMatchObject({ durationSeconds: 10, sampleRate: 44100, channels: 2, bitDepth: 16 });
  });

  it("totalSamples=0（编码器未写）→ 时长 null 不硬编", async () => {
    const env = await extractEnvelope(bufferByteSource(flacFile(48000, 1, 24, 0)), "stream.flac");
    expect(env.status).toBe("ok");
    expect(env.data?.durationSeconds).toBeNull();
  });
});

// ─── MP3 ─────────────────────────────────────────────────────────────────────

describe("mp3Parser", () => {
  it("VBR + Xing 帧计数 → 精确时长，estimated: false", async () => {
    const env = await extractEnvelope(bufferByteSource(mp3Frame({ xingFrames: 1000 })), "vbr.mp3");
    expect(env.status).toBe("ok");
    expect(env.data).toMatchObject({ estimated: false, vbr: true, sampleRate: 44100, channels: 2 });
    expect(env.data?.durationSeconds).toBeCloseTo((1000 * 1152) / 44100, 3);
  });

  it("CBR 无 Xing → 码率估算，诚实标 estimated: true", async () => {
    const raw = Buffer.concat([mp3Frame(), Buffer.alloc(16000 - 1044)]); // 共 16000 字节
    const env = await extractEnvelope(bufferByteSource(raw), "cbr.mp3");
    expect(env.data).toMatchObject({ estimated: true, bitrateKbps: 128 });
    expect(env.data?.durationSeconds).toBeCloseTo(1.0, 3);
  });

  it("ID3v2 标签（syncsafe 尺寸）跳过后找首帧", async () => {
    const id3 = Buffer.alloc(110); // 10 头 + 100 标签体
    id3.write("ID3", 0, "latin1");
    id3[9] = 100; // syncsafe size
    const env = await extractEnvelope(
      bufferByteSource(Buffer.concat([id3, mp3Frame({ xingFrames: 500 })])), "tagged.mp3");
    expect(env.status).toBe("ok");
    expect(env.data?.durationSeconds).toBeCloseTo((500 * 1152) / 44100, 3);
  });
});

// ─── ISO BMFF ────────────────────────────────────────────────────────────────

describe("isobmffParser", () => {
  it("跳 mdat 找尾部 moov：mvhd 时长 + tkhd 视频尺寸 + brand", async () => {
    const env = await extractEnvelope(bufferByteSource(mp4File()), "clip.mp4");
    expect(env.status).toBe("ok");
    expect(env.parserKey).toBe("isobmff"); // 信封存 parser.key，非注册表类型键
    expect(env.detectedType).toBe("video/mp4");
    expect(env.data).toMatchObject({ durationSeconds: 10, width: 1920, height: 1080, brand: "isom" });
  });

  it("无 moov（裸 mdat 流）→ failed 终态", async () => {
    const broken = Buffer.concat([
      box("ftyp", Buffer.concat([Buffer.from("isom", "latin1"), Buffer.alloc(4)])),
      box("mdat", Buffer.alloc(64)),
    ]);
    const env = await extractEnvelope(bufferByteSource(broken), "broken.mp4");
    expect(env.status).toBe("failed");
  });
});

// ─── ZIP ─────────────────────────────────────────────────────────────────────

describe("zipParser", () => {
  const localHdr = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

  it("EOCD entry 数（尾部 Range 定位）", async () => {
    const env = await extractEnvelope(
      bufferByteSource(Buffer.concat([localHdr, Buffer.alloc(200), zipEocd(5)])), "交付包.zip");
    expect(env.status).toBe("ok");
    expect(env.data).toMatchObject({ entryCount: 5 });
  });

  it("带注释的 EOCD 也能反扫到", async () => {
    const eocd = zipEocd(3, 100);
    eocd.write("archive comment", 22, "latin1");
    const env = await extractEnvelope(
      bufferByteSource(Buffer.concat([localHdr, Buffer.alloc(50), eocd])), "commented.zip");
    expect(env.data).toMatchObject({ entryCount: 3 });
  });

  it("zip64：0xFFFF 哨兵 → 走 locator 取 64 位 entry 数", async () => {
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(BigInt(70000), 32);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(0), 8); // z64 EOCD 在 offset 0
    const buf = Buffer.concat([z64, locator, zipEocd(0xffff)]);
    const data = await zipParser.parse(bufferByteSource(buf), buf.subarray(0, 4096));
    expect(data).toMatchObject({ entryCount: 70000, zip64: true });
  });

  it("size 未知（存量 NULL 行）定位不了 EOCD → 确定性 failed", async () => {
    const buf = Buffer.concat([localHdr, zipEocd(1)]);
    const src = { size: null, read: bufferByteSource(buf).read };
    const env = await extractEnvelope(src, "legacy.zip");
    expect(env.status).toBe("failed");
  });
});

// ─── ZIP central directory 清单（PR2，zipParser v2）─────────────────────────

function cdEntry(o: {
  name: Buffer; utf8?: boolean; size?: number; csize?: number; method?: number;
  offset?: number; encrypted?: boolean; mdate?: number; mtimeDos?: number;
}): Buffer {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE((o.utf8 ? 0x800 : 0) | (o.encrypted ? 1 : 0), 8);
  b.writeUInt16LE(o.method ?? 8, 10);
  b.writeUInt16LE(o.mtimeDos ?? 0, 12);
  b.writeUInt16LE(o.mdate ?? (((2026 - 1980) << 9) | (9 << 5) | 6), 14); // 2026-09-06
  b.writeUInt32LE(0x1234abcd, 16);
  b.writeUInt32LE(o.csize ?? 100, 20);
  b.writeUInt32LE(o.size ?? 300, 24);
  b.writeUInt16LE(o.name.length, 28);
  b.writeUInt32LE(o.offset ?? 0, 42);
  return Buffer.concat([b, o.name]);
}

function zipFile(cdEntries: Buffer[]): Buffer {
  const prefix = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]); // 本体占位
  const cd = Buffer.concat(cdEntries);
  const eocd = zipEocd(cdEntries.length);
  eocd.writeUInt32LE(cd.length, 12);   // cdSize
  eocd.writeUInt32LE(prefix.length, 16); // cdOffset
  return Buffer.concat([prefix, cd, eocd]);
}

describe("zipParser v2：central directory 清单", () => {
  it("公约 entry 形状：路径/尺寸/目录/加密/method/offset/mtime", async () => {
    const zip = zipFile([
      cdEntry({ name: Buffer.from("audio/", "utf8"), utf8: true, size: 0, csize: 0 }),
      cdEntry({ name: Buffer.from("audio/主题曲.wav", "utf8"), utf8: true, size: 48000, csize: 40000, method: 8, offset: 64, mtimeDos: (12 << 11) | (30 << 5) | 5 }),
      cdEntry({ name: Buffer.from("readme.txt", "utf8"), utf8: true, size: 10, encrypted: true }),
    ]);
    const env = await extractEnvelope(bufferByteSource(zip), "交付.zip");
    expect(env.status).toBe("ok");
    expect(env.data).toMatchObject({ entryCount: 3, totalUncompressedBytes: 48010 });
    const entries = env.data?.entries as Record<string, unknown>[];
    expect(entries[0]).toMatchObject({ path: "audio/", isDirectory: true });
    expect(entries[1]).toMatchObject({
      path: "audio/主题曲.wav", uncompressedBytes: 48000, compressedBytes: 40000,
      isDirectory: false, method: 8, offset: 64, mtime: "2026-09-06T12:30:10",
    });
    expect(entries[1].encodingGuessed).toBeUndefined();
    expect(entries[2]).toMatchObject({ encrypted: true });
  });

  it("无 UTF-8 flag 的非 ASCII 名按 GBK 猜并标 encodingGuessed（国内 Windows zip 现实）", async () => {
    const gbkName = Buffer.concat([Buffer.from([0xd6, 0xd0]), Buffer.from(".txt", "latin1")]); // GBK「中」
    const env = await extractEnvelope(bufferByteSource(zipFile([cdEntry({ name: gbkName })])), "win.zip");
    const entries = env.data?.entries as Record<string, unknown>[];
    expect(entries[0]).toMatchObject({ path: "中.txt", encodingGuessed: true });
  });

  it("超 ARCHIVE_ENTRY_CAP 截断并标 truncated，entryCount 保留声明总数", async () => {
    const many = Array.from({ length: ARCHIVE_ENTRY_CAP + 1 }, (_, i) =>
      cdEntry({ name: Buffer.from(`f${i}.txt`, "latin1"), size: 1 }));
    const env = await extractEnvelope(bufferByteSource(zipFile(many)), "huge.zip");
    expect(env.status).toBe("ok");
    expect((env.data?.entries as unknown[]).length).toBe(ARCHIVE_ENTRY_CAP);
    expect(env.data).toMatchObject({ entryCount: ARCHIVE_ENTRY_CAP + 1, truncated: true });
  });
});

// ─── RAR5（PR2）──────────────────────────────────────────────────────────────

const RAR5_SIG_T = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

function vint(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

function rarBlock(type: number, fields: Buffer, dataSize = 0): Buffer {
  const flags = dataSize > 0 ? 0x2 : 0;
  const hdr = Buffer.concat([vint(type), vint(flags), ...(dataSize > 0 ? [vint(dataSize)] : []), fields]);
  return Buffer.concat([Buffer.alloc(4), vint(hdr.length), hdr, Buffer.alloc(dataSize)]);
}

function rarFileHeader(name: string, unpacked: number, dataSize: number, o?: { dir?: boolean; mtime?: number }): Buffer {
  const ff = (o?.dir ? 1 : 0) | (o?.mtime ? 2 : 0);
  const nameB = Buffer.from(name, "utf8");
  const mtimeB = o?.mtime ? (() => { const b = Buffer.alloc(4); b.writeUInt32LE(o.mtime, 0); return b; })() : Buffer.alloc(0);
  const fields = Buffer.concat([
    vint(ff), vint(unpacked), vint(0), mtimeB,
    vint(1 << 7), // compression info：method=1
    vint(2), vint(nameB.length), nameB,
  ]);
  return rarBlock(2, fields, dataSize);
}

function rar5File(blocks: Buffer[]): Buffer {
  return Buffer.concat([
    RAR5_SIG_T,
    rarBlock(1, vint(0)),      // main archive header
    ...blocks,
    rarBlock(5, vint(0)),      // end of archive
  ]);
}

describe("rarParser", () => {
  it("逐块走位收 file 头：路径/尺寸/目录/method/offset", async () => {
    const rar = rar5File([
      rarFileHeader("素材/", 0, 0, { dir: true }),
      rarFileHeader("素材/cue表.xlsx", 12000, 8000, { mtime: 1757000000 }),
      rarFileHeader("notes.txt", 50, 30),
    ]);
    const env = await extractEnvelope(bufferByteSource(rar), "交付.rar");
    expect(env.status).toBe("ok");
    expect(env.parserKey).toBe("application/vnd.rar");
    expect(env.data).toMatchObject({ entryCount: 3, totalUncompressedBytes: 12050 });
    const entries = env.data?.entries as Record<string, unknown>[];
    expect(entries[0]).toMatchObject({ path: "素材/", isDirectory: true });
    expect(entries[1]).toMatchObject({
      path: "素材/cue表.xlsx", uncompressedBytes: 12000, compressedBytes: 8000, method: 1,
      mtime: new Date(1757000000 * 1000).toISOString(),
    });
    expect(entries[1].offset).toBeGreaterThan(8); // data 区起点（PR3 包内取文件用）
  });

  it("rar4 缓议：明确 failed 终态（将来 bump version 自动重算存量）", async () => {
    const rar4 = Buffer.concat([Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), Buffer.alloc(64)]);
    const env = await extractEnvelope(bufferByteSource(rar4), "old.rar");
    expect(env.status).toBe("failed");
    expect(env.error).toContain("RAR4");
  });

  it("加密档案（头加密块）→ failed 终态", async () => {
    const rar = Buffer.concat([RAR5_SIG_T, rarBlock(4, vint(0))]);
    const env = await extractEnvelope(bufferByteSource(rar), "locked.rar");
    expect(env.status).toBe("failed");
    expect(env.error).toContain("encrypted");
  });

  it("预算走完收部分清单 + truncated（不落 oversized 丢掉已走到的）", async () => {
    // 三个文件各隔 70KB 数据区（超 64KB 窗口 ⇒ 每个头一次 Range），maxReads=2
    const rar = rar5File([
      rarFileHeader("a.bin", 1, 70000),
      rarFileHeader("b.bin", 1, 70000),
      rarFileHeader("c.bin", 1, 70000),
    ]);
    const head = rar.subarray(0, 4096);
    const data = await rarParser.parse(withBudget(bufferByteSource(rar), { maxBytes: 10 * 1024 * 1024, maxReads: 2 }), head);
    expect((data.entries as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect(data.truncated).toBe(true);
  });
});

// ─── 批次版本 ─────────────────────────────────────────────────────────────────

it("broker 版本单调不回退（精确断言在最新批的测试文件里）", () => {
  expect(BROKER_VERSION).toBeGreaterThanOrEqual(3);
});
