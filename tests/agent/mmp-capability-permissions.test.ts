import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Capability } from "@mmp/client";

const mocks = vi.hoisted(() => ({
  getAttachment: vi.fn(),
  resolveAsset: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@/lib/agent/attachment-db", () => ({
  getReadyAttachmentForSession: mocks.getAttachment,
}));
vi.mock("@/lib/agent/tools/doc-tools", () => ({
  resolveReadableAsset: mocks.resolveAsset,
}));
vi.mock("@/lib/mmp/capability-runner", () => ({
  runMmpCapability: mocks.run,
}));

import { runAssetCapability, runAttachmentCapability } from "@/lib/agent/tools/mmp-capability-tools";

const capability: Capability = {
  id: "pitch_transcribe",
  purpose: "music.pitch_transcribe",
  tiers: [{ tier: "cpu", engine: "pitch", engine_version: "1", cost: "low" }],
  input: { media: { presence: "required", accepts: ["audio/*"] } },
  output: { schema: { type: "object" }, agent_context: "none" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue("ok");
});

describe("MMP 动态能力权限壳", () => {
  it("附件只按当前 session + 当前用户查询；伪造、跨会话或他人的 id 不会到达 MMP", async () => {
    mocks.getAttachment.mockResolvedValue(null);
    await expect(runAttachmentCapability("u1", null, "s1", "att_forged", { capability }))
      .resolves.toContain("不属于当前会话");
    expect(mocks.getAttachment).toHaveBeenCalledWith("att_forged", "s1", "u1");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("附件授权后只向执行器传服务端文件行，不接受模型提供 mediaId", async () => {
    mocks.getAttachment.mockResolvedValue({
      id: "att_1", sessionId: "s1", r2Key: "agent-attachments/att_1/a.wav",
      fileName: "a.wav", mimeType: "audio/wav", mediaKind: "audio", fileSize: 12, status: "ready",
    });
    await expect(runAttachmentCapability("u1", null, "s1", "att_1", { capability })).resolves.toBe("ok");
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      file: { fileId: "att_1", r2Key: "agent-attachments/att_1/a.wav", mimeType: "audio/wav" },
      userId: "u1",
    }), expect.anything());
  });

  it("资产复用预览权限门；无权时不把文件位置交给 MMP", async () => {
    mocks.resolveAsset.mockResolvedValue("你没有查看该资产的权限。");
    await expect(runAssetCapability("u1", "p1", "asset_private", { capability }))
      .resolves.toContain("没有查看该资产的权限");
    expect(mocks.resolveAsset).toHaveBeenCalledWith("u1", "p1", "asset_private");
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
