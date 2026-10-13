import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Capability } from "@mmp/client";

const mocks = vi.hoisted(() => ({ getAttachment: vi.fn(), getAnyAttachment: vi.fn(), resolveAsset: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/agent/attachment-db", () => ({
  getReadyAttachmentForSession: mocks.getAttachment,
  getAttachmentForSession: mocks.getAnyAttachment,
  recordAttachmentAccess: vi.fn(),
}));
vi.mock("@/lib/agent/tools/doc-tools", () => ({ resolveReadableAsset: mocks.resolveAsset }));
vi.mock("@/lib/mmp/capability-runner", () => ({ runMmpCapability: mocks.run }));

import { runCapability } from "@/lib/agent/tools/mmp-capability-tools";

const capability: Capability = {
  id: "pitch_transcribe", visibility: "public", purpose: "music.pitch_transcribe",
  tiers: [{ tier: "cpu", engine: "pitch", engine_version: "1", cost: "low" }],
  input: { fields: [{ name: "recording", kind: "media", required: true, accepts: ["audio/*"], cardinality: { min: 1, max: 1 } }] },
  output: { fields: [{ name: "notes", kind: "json", required: true, schema: { type: "object" } }], agent_context: "none" },
};

const base = { userId: "u1", productionId: null, sessionId: "s1", runId: "r1", toolCallId: "c1", capability };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAnyAttachment.mockResolvedValue(null);
  mocks.run.mockImplementation(async (args: { resolveMedia: (name: string, raw: unknown, capability: Capability) => Promise<unknown>; rawArguments: Record<string, unknown> }) => {
    await args.resolveMedia("recording", args.rawArguments.recording, capability);
    return { text: "ok", attachments: [], media: [] };
  });
});

describe("MMP 动态能力权限壳", () => {
  it("附件只按当前 session + 当前用户查询；伪造、跨会话或他人的 id 不会到达 MMP", async () => {
    mocks.getAttachment.mockResolvedValue(null);
    await expect(runCapability({ ...base, rawArguments: { recording: { attachmentId: "att_forged" } } }))
      .rejects.toThrow("不属于当前会话");
    expect(mocks.getAttachment).toHaveBeenCalledWith("att_forged", "s1", "u1");
  });

  it("附件授权后只从服务端文件行构造句柄，不接受模型提供 mediaId", async () => {
    mocks.getAttachment.mockResolvedValue({ id: "att_1", sessionId: "s1", r2Key: "agent-attachments/att_1/a.wav",
      fileName: "a.wav", mimeType: "audio/wav", mediaKind: "audio", fileSize: 12, status: "ready" });
    await expect(runCapability({ ...base, rawArguments: { recording: { attachmentId: "att_1", mediaId: "forged" } } })).resolves.toMatchObject({ text: "ok" });
    const resolver = mocks.run.mock.calls[0][0].resolveMedia;
    await expect(resolver("recording", { attachmentId: "att_1" }, capability)).resolves.toMatchObject({
      value: { get: { url: expect.stringContaining("agent-attachments/att_1/a.wav") } }, cacheKeys: ["att_1"],
    });
  });

  it("资产复用预览权限门；无权时不把文件位置交给 MMP", async () => {
    mocks.resolveAsset.mockResolvedValue("你没有查看该资产的权限。");
    await expect(runCapability({ ...base, productionId: "p1", rawArguments: { recording: { assetId: "asset_private" } } }))
      .rejects.toThrow("没有查看该资产的权限");
    expect(mocks.resolveAsset).toHaveBeenCalledWith("u1", "p1", "asset_private");
  });

  it("资产通过预览权限门后，用服务端解析出的文件行构造同一命名字段", async () => {
    mocks.resolveAsset.mockResolvedValue({ asset: { id: "asset_1", mimeType: "audio/flac" }, file: { id: "file_1", r2Key: "assets/file_1/a.flac" } });
    await expect(runCapability({ ...base, productionId: "p1", rawArguments: { recording: { assetId: "asset_1" } } })).resolves.toMatchObject({ text: "ok" });
  });
});
