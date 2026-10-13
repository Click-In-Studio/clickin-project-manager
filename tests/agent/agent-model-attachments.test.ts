import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import {
  prepareModelAttachments,
  restoreModelMedia,
  type MediaInput,
} from "@/lib/agent/runtime/model-attachments";
import { resolveModel } from "@/lib/agent/runtime/config";
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
  it("归属不符不取原件；超过媒体体积时走预检并明确说明", async () => {
    state.rows = [{ ...attachment(10), sessionId: "another" }];
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      prepareModelAttachments("读图片", ["picture"], input),
    ).rejects.toThrow("不属于该会话");
    expect(fetch).not.toHaveBeenCalled();
    state.rows = [attachment(30 * 1024 * 1024)];
    const oversized = await prepareModelAttachments(
      "读图片",
      ["picture"],
      input,
    );
    expect(oversized.media).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(oversized.text).toContain("超过预算");
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
