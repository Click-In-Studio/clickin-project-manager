import { restoreModelMedia } from "@/lib/agent/runtime/model-media-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import {
  prepareModelAttachments,
  type MediaInput,
} from "@/lib/agent/runtime/model-attachments";
import { llmRuntime, resolveModel } from "@/lib/agent/runtime/config";
import type { AgentAttachment } from "@/lib/agent/attachment-db";
const state = vi.hoisted(() => ({
  rows: [] as AgentAttachment[],
  access: vi.fn(),
  preflight: vi.fn(async (_inputs: unknown[], _options?: unknown) => ({})),
}));
vi.mock("@/lib/agent/attachment-db", () => ({
  getReadyAttachments: async (ids: string[], session: string, user: string) =>
    state.rows.filter(
      (row) =>
        ids.includes(row.id) &&
        row.sessionId === session &&
        user === "owner" &&
        row.status === "ready",
    ),
  listAttachmentsForSession: async (session: string) =>
    state.rows.filter((row) => row.sessionId === session),
  recordAttachmentAccess: state.access,
}));
vi.mock("@/lib/r2", () => ({
  presignedGet: () => "https://blob.test/immutable",
}));
vi.mock("@/lib/mmp/attachment-preflight", () => ({
  preflightAttachments: state.preflight,
}));
const input: MediaInput = {
  sessionId: "session",
  userId: "owner",
  productionId: null,
  runId: "run",
  model: resolveModel("deepseek-flash"),
  signal: new AbortController().signal,
};
function attachment(bytes: number): AgentAttachment {
  return {
    id: "picture",
    sessionId: "session",
    status: "ready",
    fileName: "舞台.png",
    mimeType: "image/png",
    fileSize: bytes,
    r2Key: "immutable",
    mediaKind: "image",
  } as AgentAttachment;
}
beforeEach(() => {
  state.rows = [];
  state.access.mockClear();
  state.preflight.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("原件准备与恢复", () => {
  it("灵光将超过旧 14 MiB 上限的音频和图片送入真实 SDK 原生请求，保留总载荷上限", async () => {
    const pcmBytes = 16 * 1024 * 1024;
    const bytes = Buffer.alloc(44 + pcmBytes);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(2, 22);
    bytes.writeUInt32LE(48000, 24);
    bytes.writeUInt32LE(192000, 28);
    bytes.writeUInt16LE(4, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(pcmBytes, 40);
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    }).png().toBuffer();
    const sound = {
      ...attachment(bytes.length),
      id: "sound",
      fileName: "声音.wav",
      mimeType: "audio/wav",
      mediaKind: "audio",
    };
    state.rows = [sound, attachment(png.length)];
    let payload = "";
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)))
      .mockResolvedValueOnce(new Response(new Uint8Array(png)))
      .mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
        payload = String(init?.body);
        const response = {
          candidates: [{
            content: { role: "model", parts: [{ text: "已收到音频" }] },
            finishReason: "STOP",
          }],
          usageMetadata: {
            promptTokenCount: 3000,
            candidatesTokenCount: 5,
            totalTokenCount: 3005,
          },
        };
        return new Response(`data: ${JSON.stringify(response)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      });
    vi.stubGlobal("fetch", fetch);
    const model = resolveModel("inspiration");
    const result = await prepareModelAttachments(
      "分析声音和图片", ["sound", "picture"], { ...input, model },
    );
    expect(result.media.map((part) => part.type)).toEqual(["audio", "image"]);
    expect(result.media[0].budget?.durationSeconds).toBeCloseTo(pcmBytes / 192000);
    expect(state.preflight.mock.calls[0][0]).toEqual([]);
    const reply = await llmRuntime().completeSimple(
      model,
      { messages: [{
        role: "user",
        timestamp: 1,
        content: [{ type: "text", text: result.text }, ...result.media],
      }] },
      { apiKey: "test", maxTokens: 100 },
    );
    expect(reply.stopReason).toBe("stop");
    const parts = JSON.parse(payload).contents[0].parts;
    const nativeAudio = parts.find(
      (part: { inlineData?: { mimeType: string } }) =>
        part.inlineData?.mimeType === "audio/wav",
    );
    expect(Buffer.from(nativeAudio.inlineData.data, "base64").equals(bytes)).toBe(true);
    expect(parts.some(
      (part: { inlineData?: { mimeType: string } }) =>
        part.inlineData?.mimeType === "image/png",
    )).toBe(true);
    state.rows = [{ ...sound, fileSize: 71_250_001 }];
    state.preflight.mockClear();
    const oversized = await prepareModelAttachments("听声音", ["sound"], { ...input, model });
    expect(oversized.media).toEqual([]);
    expect(state.preflight).toHaveBeenCalledWith([expect.objectContaining({ attachmentId: "sound" })], expect.anything());
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("读取真实 PNG 尺寸与版本，支持视觉时跳过 MMP；恢复时核对版本", async () => {
    const bytes = await sharp({
      create: { width: 30, height: 20, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    state.rows = [attachment(bytes.length)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(bytes))),
    );
    const result = await prepareModelAttachments(
      "看舞台图",
      ["picture"],
      input,
    );
    expect(result.media).toHaveLength(1);
    expect(result.media[0].budget).toMatchObject({
      bytes: bytes.length,
      width: 30,
      height: 20,
      estimatedTokens: 1200,
    });
    expect(result.media[0].source?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(state.preflight.mock.calls[0][0]).toEqual([]);
    const restored = await restoreModelMedia(
      [
        {
          role: "user",
          timestamp: 1,
          content: [{ ...result.media[0], data: undefined }],
        },
      ],
      input,
    );
    expect(JSON.stringify(restored)).toContain(bytes.toString("base64"));
    await expect(
      restoreModelMedia(
        [
          {
            role: "user",
            timestamp: 1,
            content: [
              {
                ...result.media[0],
                data: undefined,
                source: { kind: "attachment", sha256: "wrong-version" },
              },
            ],
          },
        ],
        input,
      ),
    ).rejects.toThrow("版本变化");
  });
  it("无音轨视频仍测出时长与分辨率，作为原生视频提供而非误降级", async () => {
    const bytes = readFileSync(
      new URL("./fixtures/silent-video.mp4", import.meta.url),
    );
    state.rows = [
      {
        ...attachment(bytes.length),
        fileName: "无声舞台.mp4",
        mimeType: "video/mp4",
        mediaKind: "video",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(bytes))),
    );
    const result = await prepareModelAttachments("看视频画面", ["picture"], {
      ...input,
      model: resolveModel("resonance"),
    });
    expect(result.media[0]).toMatchObject({
      type: "video",
      mimeType: "video/mp4",
      budget: { durationSeconds: 2, width: 64, height: 64 },
    });
    expect(state.preflight.mock.calls[0][0]).toEqual([]);
  });
  it("归属不符和原件读取失败明确报错；单件超限走 MMP", async () => {
    state.rows = [{ ...attachment(10), sessionId: "another" }];
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      prepareModelAttachments("读图片", ["picture"], input),
    ).rejects.toThrow("不属于该会话");
    expect(fetch).not.toHaveBeenCalled();
    state.rows = [attachment(30 * 1024 * 1024)];
    expect((await prepareModelAttachments("读图片", ["picture"], input)).media).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.preflight).toHaveBeenCalledWith([expect.objectContaining({ attachmentId: "picture" })], expect.anything());
    state.rows = [attachment(10)];
    state.preflight.mockClear();
    fetch.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      prepareModelAttachments("读图片", ["picture"], input),
    ).rejects.toThrow("原件读取失败");
    expect(state.preflight).not.toHaveBeenCalled();
  });
  it("模型未接入的格式才自动走解析预检，与文件大小无关", async () => {
    state.rows = [{ ...attachment(10), mimeType: "image/svg+xml" }];
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await prepareModelAttachments("读图片", ["picture"], input);
    expect(result.media).toEqual([]);
    expect(result.text).toContain("不适合原生输入");
    expect(fetch).not.toHaveBeenCalled();
    expect(state.preflight).toHaveBeenCalledWith(
      [expect.objectContaining({ attachmentId: "picture" })],
      expect.anything(),
    );
  });
  it("过期与转存附件只说明当前回查状态，不重新附带历史原件", async () => {
    const reference = {
      type: "image" as const,
      mimeType: "image/png",
      attachmentId: "picture",
      source: { kind: "attachment" as const, sha256: "old" },
    };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const status of ["expired", "promoted"] as const) {
      state.rows = [
        {
          ...attachment(10),
          status,
          promotedAssetId: status === "promoted" ? "saved-asset" : null,
        },
      ];
      const result = await restoreModelMedia(
        [{ role: "user", timestamp: 1, content: [reference] }],
        input,
      );
      expect(JSON.stringify(result)).toContain(
        status === "expired" ? "历史分析仍可参考" : "saved-asset",
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});
