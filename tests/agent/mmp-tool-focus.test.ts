import { describe, expect, it, vi } from "vitest";
import type { Capability } from "@mmp/client";
import type { AgentMessage } from "../../vendor/openclaw/packages/agent-core/src/types";

vi.mock("@/lib/agent/attachment-db", () => ({
  getReadyAttachments: async (ids: string[]) => ids.map((id) => ({
    id, mediaKind: id.includes("audio") ? "audio" : "image", mimeType: id.includes("audio") ? "video/mp4" : "image/png",
  })),
}));
vi.mock("@/lib/agent/tools/doc-tools", () => ({
  resolveReadableAsset: async (_userId: string, _productionId: string, assetId: string) => ({
    asset: { id: assetId, mimeType: assetId.includes("audio") ? "audio/wav" : "image/png" },
    file: { id: `file_${assetId}`, r2Key: `assets/${assetId}` },
  }),
}));

import { focusedMmpToolNames, MMP_FOCUS_USER_TURNS } from "@/lib/agent/runtime/mmp-tool-focus";

const capability = (id: string, accepts: string[]): Capability => ({
  id, purpose: id, description: id,
  tiers: [{ tier: "cpu", engine: id, engine_version: "1", cost: "low" }],
  input: { media: { presence: "required", accepts } },
  output: { schema: { type: "object" }, agent_context: "none" },
});
const CAPS = [capability("audio_analyze", ["audio/*"]), capability("image_analyze", ["image/*"])];

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

describe("MMP 最近资源温层", () => {
  it("最近按三个用户轮次计算；当前附件按语义 MIME 激活对应 attachment capability", async () => {
    expect(MMP_FOCUS_USER_TURNS).toBe(3);
    const names = await focusedMmpToolNames({
      messages: [
        user("<clickin-attachment-context>attachmentId: old_image</clickin-attachment-context>"),
        user("第二轮"), user("第三轮"), user("第四轮"),
      ],
      currentAttachmentIds: ["new_audio"],
      sessionId: "s", userId: "u", productionId: "p", capabilities: CAPS,
    });
    expect(names).toContain("mmp.attachment.audio_analyze");
    expect(names).not.toContain("mmp.attachment.image_analyze");
  });

  it("当前 UI asset 与模型成功读取过的 asset 都进入资产温层；失败调用不算看过", async () => {
    const messages = [
      user("<clickin-ui-context>用户此刻正查看资产文件（资产 id: image_ui）。</clickin-ui-context>看看这个"),
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "ok", name: "clickin__production-doc_outline", arguments: { assetId: "audio_seen" } },
          { type: "toolCall", id: "bad", name: "clickin__production-doc_read", arguments: { assetId: "image_failed" } },
        ],
        stopReason: "toolUse", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
      { role: "toolResult", toolCallId: "ok", toolName: "clickin__production-doc_outline", content: [{ type: "text", text: "ok" }], details: undefined, isError: false, timestamp: Date.now() },
      { role: "toolResult", toolCallId: "bad", toolName: "clickin__production-doc_read", content: [{ type: "text", text: "denied" }], details: undefined, isError: true, timestamp: Date.now() },
    ] as AgentMessage[];
    const names = await focusedMmpToolNames({
      messages, sessionId: "s", userId: "u", productionId: "p", capabilities: CAPS,
    });
    expect(names).toContain("mmp.asset.audio_analyze");
    expect(names).toContain("mmp.asset.image_analyze");
  });
});
