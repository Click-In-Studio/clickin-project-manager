import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Capability, MmpClient } from "@mmp/client";
import type { AgentAttachment } from "@/lib/agent/attachment-db";

const state = vi.hoisted(() => ({
  create: vi.fn(), ready: vi.fn(), remove: vi.fn(), head: vi.fn(), get: vi.fn(), put: vi.fn(), usage: vi.fn(),
}));
vi.mock("@/lib/agent/attachment-db", () => ({ AGENT_ATTACHMENT_MAX_BYTES: 50 * 1024 * 1024,
  createPendingAttachment: state.create, markAttachmentReady: state.ready, scheduleAttachmentDeletion: state.remove }));
vi.mock("@/lib/r2", () => ({ headR2Object: state.head, getR2Object: state.get,
  presignedPut: (key: string) => ({ url: `https://r2.test/${key}` }), putR2Object: state.put }));
vi.mock("@/lib/mmp/usage-db", () => ({ recordMmpUsage: state.usage }));
import { runMmpCapability } from "@/lib/mmp/capability-runner";

const cap = (produces: string[], max = 1): Capability => ({ id: "test.process", purpose: "test.process", visibility: "public",
  tiers: [{ tier: "cpu", engine: "test", engine_version: "1", cost: "low" }],
  input: { fields: [{ name: "options", kind: "json", required: false, schema: { type: "object" } }] },
  output: { agent_context: "none", fields: [
    { name: "result", kind: "media", required: true, produces: produces as [string, ...string[]], cardinality: { min: 1, max } },
    { name: "metadata", kind: "json", required: true, schema: { type: "object" } },
  ] },
});
const reservations = new Map<string, AgentAttachment>();
let body: Buffer;
let contentType: string;
let metadata: Record<string, unknown>;
let outputCount: number;
let corruptIndex: number;
let score: string | undefined;
let deliveryFailure: boolean;
let malformedReceipt: boolean;
const DELIVERY: Capability = { id: "node.deliver", purpose: "media.deliver", visibility: "public", tiers: [{ tier: "cpu", engine: "store", engine_version: "1", cost: "low" }],
  input: { fields: [{ name: "items", kind: "media", required: true, accepts: ["*/*"], cardinality: { min: 1, max: 2 } }] },
  output: { agent_context: "none", fields: [{ name: "files", kind: "media", required: true, produces: ["*/*"], cardinality: { min: 1, max: 2 } }] } };

beforeEach(() => {
  vi.clearAllMocks(); reservations.clear(); outputCount = 1; corruptIndex = -1; score = undefined; deliveryFailure = false; malformedReceipt = false;
  body = readFileSync("tests/_support/fixtures/mmp-output.flac"); contentType = "audio/flac";
  metadata = { files: [{ sample_rate: 48000, channels: 2, duration_sec: 0.25 }] };
  state.create.mockImplementation(async (input) => {
    const id = `${input.source.outputName}-${input.source.outputIndex}`;
    const row = { ...input, id, r2Key: id, status: "pending" } as AgentAttachment;
    reservations.set(id, row); return row;
  });
  state.ready.mockImplementation(async (id, _session, _user, bytes, sourceMetadata, file) => ({
    ...reservations.get(id), ...file, status: "ready", fileSize: bytes, sourceMetadata,
  }));
  state.head.mockImplementation(async () => ({ size: body.length, contentType }));
  state.get.mockImplementation(async () => ({ body, contentType }));
  state.remove.mockResolvedValue(true);
});

async function execute(capability = cap([contentType])) {
  if (score !== undefined) capability.output.fields.push({ name: "score", kind: "text", required: true, schema: { type: "string" } });
  let deliveredCount = 0;
  const run = vi.fn(async (job: Parameters<MmpClient["run"]>[0]) => {
    const atom = (index: number) => ({ kind: "media", content_type: contentType, bytes: body.length,
      sha256: index === corruptIndex ? "0".repeat(64) : createHash("sha256").update(body).digest("hex"),
      media_id: `sha256:${createHash("sha256").update(body).digest("hex")}` });
    if (job.type === DELIVERY.id) {
      if (deliveryFailure) throw new Error("PUT failed after partial upload");
      const refs = job.arguments.items as Array<{ ref: string }>;
      return { outputs: { files: refs.map((ref) => ({ ...atom(deliveredCount++), media_id: malformedReceipt ? "wrong-ref" : ref.ref, delivered: true })) } };
    }
    return { job_id: "node-with-hyphens-01K7MA00ECFN8H9R3CRHJSMX44", type: capability.id, status: "done", media_ids: {}, cached: false,
      source: { tier: "cpu", engine: "test", engine_version: "1", generated_at: "2026-10-15T00:00:00Z", degraded: false },
      outputs: { ...Object.fromEntries(capability.output.fields.filter((field) => field.kind === "media").map((field) => [field.name,
        field.cardinality.max > 1 ? Array.from({ length: outputCount }, (_, index) => atom(index)) : atom(0)])),
        metadata: { kind: "json", value: metadata }, ...(score !== undefined ? { score: { kind: "text", text: score } } : {}) },
      usage: { served_from: "compute", tier: "cpu", engine: "test", compute_ms: 0, wasted_ms: 0 } };
  });
  const client = { capabilities: async () => ({ capabilities: [{ capability }] }), resolveCapability: async () => DELIVERY, run } as unknown as MmpClient;
  const result = await runMmpCapability({ capability, rawArguments: { options: { start_sec: 10, end_sec: 10.25 } },
    resolveMedia: vi.fn(), userId: "u", productionId: null, sessionId: "s", runId: "r", toolCallId: "c" }, { client });
  return { result, request: run.mock.calls };
}

describe("MMP 产物接收与呈现能力独立", () => {
  it.each([["wav", "audio/wav"], ["flac", "audio/flac"], ["mp3", "audio/mpeg"], ["ogg", "audio/ogg"],
    ["opus", "audio/ogg"], ["m4a", "audio/mp4"]])("实际 %s 容器核验后保存，不自动注入原件", async (extension, mime) => {
    body = readFileSync(`tests/_support/fixtures/mmp-output.${extension}`); contentType = mime;
    const { result } = await execute(cap(["audio/wav", "audio/flac", "audio/mpeg", "audio/ogg", "audio/mp4"]));
    expect(result.attachments[0]).toMatchObject({ mimeType: mime, mediaKind: "audio", fileSize: body.length,
      sourceMetadata: { channels: 2, sampleRate: 48000, inputs: { options: { start_sec: 10, end_sec: 10.25 } } } });
    expect(result.media).toEqual([]);
    expect(result.text).toContain("当前模型尚未因此原生读取");
  });

  it.each(["png", "jpeg", "webp", "tiff"] as const)("多格式 capability 的 %s 仍可接收", async (format) => {
    body = await sharp({ create: { width: 9, height: 7, channels: 3, background: "red" } }).toFormat(format).toBuffer();
    contentType = `image/${format}`; metadata = { width: 9, height: 7 };
    const { result } = await execute(cap(["image/png", "image/jpeg", "image/webp", "image/tiff", "image/bmp", "image/avif"]));
    expect(result.attachments[0]).toMatchObject({ mimeType: contentType, sourceMetadata: { width: 9, height: 7 } });
  });

  it("BMP 可保存；不依赖浏览器能否内联显示", async () => {
    body = Buffer.alloc(58); body.write("BM"); body.writeUInt32LE(58, 2); body.writeUInt32LE(54, 10);
    body.writeUInt32LE(40, 14); body.writeInt32LE(1, 18); body.writeInt32LE(1, 22); body.writeUInt16LE(1, 26); body.writeUInt16LE(24, 28);
    contentType = "image/bmp"; metadata = { width: 1, height: 1 };
    expect((await execute()).result.attachments[0].mimeType).toBe("image/bmp");
  });

  it.each([1, 2])("动态数组返回 %i 项，只为实际输出准备等长交付地址", async (count) => {
    outputCount = count; metadata = { files: Array.from({ length: count }, () => ({ sample_rate: 48000, channels: 2, duration_sec: 0.25 })) };
    const { result, request } = await execute(cap(["audio/flac"], 3));
    expect(result.attachments.map((item) => item.fileName)).toEqual(Array.from({ length: count }, (_, index) => `result-${index + 1}.flac`));
    expect(result.attachments.map((item) => item.sourceMetadata?.outputIndex)).toEqual(Array.from({ length: count }, (_, index) => index));
    expect(state.create).toHaveBeenCalledTimes(count);
    expect(state.remove).not.toHaveBeenCalled();
    expect(request[0][0]).not.toHaveProperty("delivery");
    expect(request[1][0]).toMatchObject({ type: DELIVERY.id, node_id: "node-with-hyphens" });
    expect(request[1][0].delivery?.files).toHaveLength(count);
    expect(request[1][0].arguments.items).toHaveLength(count);
  });

  it("数组后项校验失败不登记前项，并回收全部预留", async () => {
    outputCount = 2; corruptIndex = 1;
    await expect(execute(cap(["audio/flac"], 3))).rejects.toThrow("digest 校验失败");
    expect(state.ready).not.toHaveBeenCalled(); expect(state.remove).toHaveBeenCalledTimes(2);
  });

  it("准备交付中途失败也清理已创建预留", async () => {
    const create = state.create.getMockImplementation()!;
    state.create.mockImplementationOnce(create).mockRejectedValueOnce(new Error("count quota"));
    outputCount = 2;
    await expect(execute(cap(["audio/flac"], 3))).rejects.toThrow("count quota");
    expect(state.remove).toHaveBeenCalledWith("result-0", "s", "u");
  });

  it("数组登记后项失败回收全部结果，不留下前项的伪成功", async () => {
    outputCount = 2; metadata = { files: [{ sample_rate:48000,channels:2,duration_sec:0.25 },{ sample_rate:48000,channels:2,duration_sec:0.25 }] };
    const ready = state.ready.getMockImplementation()!;
    state.ready.mockImplementationOnce(ready).mockRejectedValueOnce(new Error("db failure"));
    await expect(execute(cap(["audio/flac"], 3))).rejects.toThrow("db failure");
    expect(state.remove).toHaveBeenCalledTimes(2);
  });

  it("实测对象超过单件上限时不读取或登记，并进入清理", async () => {
    state.head.mockResolvedValueOnce({ size:51*1024*1024,contentType });
    await expect(execute()).rejects.toThrow("超过上限");
    expect(state.get).not.toHaveBeenCalled(); expect(state.ready).not.toHaveBeenCalled();
    expect(state.remove).toHaveBeenCalledOnce();
  });

  it("声明与实际格式不符、音轨元数据不符均拒绝", async () => {
    contentType = "audio/wav";
    await expect(execute()).rejects.toThrow();
    contentType = "audio/flac"; metadata = { files: [{ sample_rate: 48000, channels: 1, duration_sec: 0.25 }] };
    await expect(execute()).rejects.toThrow("音频采样率、声道或时长");
  });

  it("多个命名媒体字段保留各自名称与索引，并按批次一起交付", async () => {
    const capability = cap(["audio/flac"]);
    capability.output.fields.push({ name: "companion", kind: "media", required: true, produces: ["audio/flac"], cardinality: { min: 1, max: 1 } });
    const { result, request } = await execute(capability);
    expect(result.attachments.map((item) => item.fileName)).toEqual(["result.flac", "companion.flac"]);
    expect(result.attachments.map((item) => [item.sourceMetadata?.outputName, item.sourceMetadata?.outputIndex])).toEqual([["result", 0], ["companion", 0]]);
    expect(request[1][0].delivery?.files).toHaveLength(2);
  });

  it("按交付能力上限分批，输出不遗漏", async () => {
    outputCount = 3; metadata = { files: Array.from({ length: 3 }, () => ({ sample_rate: 48000, channels: 2, duration_sec: 0.25 })) };
    const { result, request } = await execute(cap(["audio/flac"], 4));
    expect(result.attachments).toHaveLength(3);
    expect(request.slice(1).map(([job]) => (job.arguments.items as unknown[]).length)).toEqual([2, 1]);
    expect(request.slice(1).map(([job]) => (job.delivery?.files as unknown[]).length)).toEqual([2, 1]);
  });

  it.each(["partial", "receipt"])("%s 交付失败清理本批全部对象且不登记成功", async (mode) => {
    outputCount = 2; deliveryFailure = mode === "partial"; malformedReceipt = mode === "receipt";
    await expect(execute(cap(["audio/flac"], 3))).rejects.toThrow();
    expect(state.ready).not.toHaveBeenCalled();
    expect(state.remove).toHaveBeenCalledTimes(2);
    expect(state.usage).toHaveBeenCalledOnce();
  });

  it("返回数量超出 capability 时不分配附件或交付", async () => {
    outputCount = 4;
    await expect(execute(cap(["audio/flac"], 3))).rejects.toThrow("输出数量或形状");
    expect(state.create).not.toHaveBeenCalled();
  });

  it("完整长曲谱保存为文本附件；截断展示仍保留回查引用", async () => {
    score = "音符".repeat(50_000);
    const { result } = await execute();
    expect(state.put).toHaveBeenCalledWith("score-0", Buffer.from(score), "text/plain");
    expect(result.attachments[1]).toMatchObject({ fileName: "score.txt", mimeType: "text/plain", fileSize: Buffer.byteLength(score) });
    expect(result.text).toContain("attachmentId=score-0");
    expect(result.text.length).toBeLessThan(24_100);
  });
});
