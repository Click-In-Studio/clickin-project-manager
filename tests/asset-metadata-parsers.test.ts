import { describe, it, expect } from "vitest";
import { extractEnvelope } from "@/lib/asset/metadata";
import { sniffDetectedType, BROKER_VERSION } from "@/lib/asset/metadata-broker";
import { zipParser } from "@/lib/asset/metadata-parsers";
import { bufferByteSource } from "@/lib/asset/byte-source";

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

// ─── 批次版本 ─────────────────────────────────────────────────────────────────

it("PR1 批 bump 到 BROKER_VERSION 2（存量 unsupported 信封重 broker 的通道）", () => {
  expect(BROKER_VERSION).toBe(2);
});
