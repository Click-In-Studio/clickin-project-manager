import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createAsset, getAssetFile, getLatestAssetFile } from "@/lib/asset/db";
import {
  extractEnvelope, isEnvelopeStale, setAssetFileMetadata, getOrExtractFileMetadata,
  type MetadataEnvelope,
} from "@/lib/asset/metadata";
import { BROKER_VERSION, sniffDetectedType } from "@/lib/asset/metadata-broker";
import {
  bufferByteSource, withBudget, ByteBudgetExceededError, TransientReadError, type ByteSource,
} from "@/lib/asset/byte-source";
import { makeProduction, cleanupProduction } from "./factories";

// #85 元数据基建：broker 判型（magic 主判/扩展名破同门）、信封状态机
// （ok/failed/unsupported/oversized + 版本失效）、预算护栏、JSONB 持久化。

function minimalPng(width = 1920, height = 1080): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;  // bitDepth
  b[25] = 6;  // colorType RGBA
  return b;
}

describe("broker 判型", () => {
  it("magic 主判：PNG 字节就是 PNG，扩展名/声明谎报无效", () => {
    expect(sniffDetectedType(minimalPng(), "actually.mp3")).toBe("image/png");
  });

  it("zip 同门靠扩展名分家", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(sniffDetectedType(zip, "报告.docx"))
      .toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(sniffDetectedType(zip, "素材包.zip")).toBe("application/zip");
    expect(sniffDetectedType(zip, "未知扩展.xyz")).toBe("application/zip");
  });

  it("RIFF 容器按 8 偏移子类型分派", () => {
    const wav = Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1")]);
    expect(sniffDetectedType(wav, "cue.wav")).toBe("audio/wav");
  });

  it("ISO BMFF 按 brand 分派（magic 在 offset 4）", () => {
    const m4a = Buffer.from("\0\0\0\x20ftypM4A \0\0\0\0", "latin1");
    expect(sniffDetectedType(m4a, "voice.m4a")).toBe("audio/mp4");
  });

  it("认不出返回 null，不回落声明值", () => {
    expect(sniffDetectedType(Buffer.from("hello world plain text"), "notes.txt")).toBeNull();
  });
});

describe("extractEnvelope 状态机", () => {
  it("PNG → ok + 尺寸数据", async () => {
    const env = await extractEnvelope(bufferByteSource(minimalPng(800, 600)), "海报.png");
    expect(env.status).toBe("ok");
    expect(env.parserKey).toBe("image/png");
    expect(env.detectedType).toBe("image/png");
    expect(env.brokerVersion).toBe(BROKER_VERSION);
    expect(env.data).toMatchObject({ width: 800, height: 600, bitDepth: 8 });
  });

  it("判型成功但无分析器 → unsupported，detectedType 仍保留（UI 徽标价值）", async () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const env = await extractEnvelope(bufferByteSource(zip), "素材.zip");
    expect(env.status).toBe("unsupported");
    expect(env.detectedType).toBe("application/zip");
    expect(env.parserKey).toBeNull();
  });

  it("判型失败 → unsupported + detectedType null", async () => {
    const env = await extractEnvelope(bufferByteSource(Buffer.from("plain text")), "notes.txt");
    expect(env.status).toBe("unsupported");
    expect(env.detectedType).toBeNull();
  });

  it("0 字节文件（对应 R2 416→空读）落 unsupported 终态，不许永远重试", async () => {
    const env = await extractEnvelope(bufferByteSource(Buffer.alloc(0)), "empty.png");
    expect(env.status).toBe("unsupported");
    expect(env.detectedType).toBeNull();
  });

  it("分析器确定性抛错 → failed 落信封（不上抛）", async () => {
    const truncated = minimalPng().subarray(0, 20); // magic 完整、IHDR 残缺
    const env = await extractEnvelope(bufferByteSource(truncated), "broken.png");
    expect(env.status).toBe("failed");
    expect(env.parserKey).toBe("image/png");
    expect(env.error).toBeTruthy();
  });

  it("瞬态读失败原样上抛（不许固化成 failed）", async () => {
    const src: ByteSource = {
      size: null,
      read: async () => { throw new TransientReadError("network flake"); },
    };
    await expect(extractEnvelope(src, "any.png")).rejects.toBeInstanceOf(TransientReadError);
  });
});

describe("预算护栏", () => {
  it("超 maxReads / maxBytes 抛 ByteBudgetExceededError", async () => {
    const src = withBudget(bufferByteSource(Buffer.alloc(4096)), { maxBytes: 100, maxReads: 2 });
    await expect(src.read(0, 200)).rejects.toBeInstanceOf(ByteBudgetExceededError);
    const src2 = withBudget(bufferByteSource(Buffer.alloc(4096)), { maxBytes: 10_000, maxReads: 1 });
    await src2.read(0, 10);
    await expect(src2.read(10, 10)).rejects.toBeInstanceOf(ByteBudgetExceededError);
  });
});

describe("版本失效", () => {
  const fresh: MetadataEnvelope = {
    status: "unsupported", brokerVersion: BROKER_VERSION, parserKey: null, parserVersion: null,
    detectedType: null, extractedAt: new Date().toISOString(), data: null, sidecarKey: null, error: null,
  };

  it("brokerVersion 落后 → 重算（新分析器上线的重 broker 通道）", () => {
    expect(isEnvelopeStale({ ...fresh, brokerVersion: BROKER_VERSION - 1 })).toBe(true);
    expect(isEnvelopeStale(fresh)).toBe(false);
  });

  it("命中过的分析器升级 → 只有它的信封失效", () => {
    const hit: MetadataEnvelope = { ...fresh, status: "ok", parserKey: "image/png", parserVersion: 0 };
    expect(isEnvelopeStale(hit)).toBe(true);
    expect(isEnvelopeStale({ ...hit, parserVersion: 999 })).toBe(false);
    // 已退役分析器的信封不算 stale（没有新版本可比）
    expect(isEnvelopeStale({ ...hit, parserKey: "audio/dead-format" })).toBe(false);
  });
});

describe("持久化与懒轨", () => {
  let prodId: string;
  let uploaderId: string;
  let fileId: string;

  beforeAll(async () => {
    const made = await makeProduction();
    prodId = made.prodId;
    const { getPool } = await import("@/lib/pg");
    const u = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
    uploaderId = u.rows[0].id;
    const created = await createAsset({
      productionId: prodId, uploaderUserId: uploaderId, assetType: "reference",
      fileName: "poster.png", mimeType: "image/png", storageType: "r2",
      r2Key: "assets/test/poster.png", fileSize: 33,
    });
    fileId = created.file.id;
  });

  afterAll(async () => {
    await cleanupProduction(prodId).catch(() => {});
  });

  it("信封 JSONB 往返：setAssetFileMetadata → getAssetFile/getLatestAssetFile", async () => {
    const env = await extractEnvelope(bufferByteSource(minimalPng()), "poster.png");
    await setAssetFileMetadata(fileId, env);
    const file = await getAssetFile(fileId);
    expect(file?.metadata).toEqual(env);
    const latest = await getLatestAssetFile(file!.assetId);
    expect(latest?.metadata?.status).toBe("ok");
  });

  it("新鲜信封短路：不碰 R2 直接返回", async () => {
    const file = await getAssetFile(fileId);
    const got = await getOrExtractFileMetadata(file!, "poster.png");
    expect(got).toEqual(file!.metadata);
  });

  it("r2Key 为空（feishu 链接类）直接回 null 信封", async () => {
    const file = await getAssetFile(fileId);
    const got = await getOrExtractFileMetadata({ ...file!, r2Key: null, metadata: null }, "x.png");
    expect(got).toBeNull();
  });
});
