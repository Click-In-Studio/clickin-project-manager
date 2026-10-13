import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Capability, MmpClient } from "@mmp/client";

const attachmentMocks = vi.hoisted(() => ({ create: vi.fn(), ready: vi.fn(), remove: vi.fn() }));
const r2Mocks = vi.hoisted(() => ({ head: vi.fn(), get: vi.fn(), put: vi.fn() }));
const usageMocks = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/agent/attachment-db", () => ({
  AGENT_ATTACHMENT_MAX_BYTES: 50 * 1024 * 1024,
  createPendingAttachment: attachmentMocks.create,
  markAttachmentReady: attachmentMocks.ready,
  scheduleAttachmentDeletion: attachmentMocks.remove,
}));
vi.mock("@/lib/r2", () => ({
  headR2Object: r2Mocks.head,
  getR2Object: r2Mocks.get,
  presignedPut: r2Mocks.put,
}));
vi.mock("@/lib/mmp/usage-db", () => ({ recordMmpUsage: usageMocks.record }));

import { runMmpCapability } from "@/lib/mmp/capability-runner";

const CAPABILITY: Capability = {
  id: "test.generate", visibility: "public", purpose: "test.generate", description: "测试生成",
  tiers: [{ tier: "gpu", engine: "test-engine", engine_version: "1", cost: "high" }],
  input: { fields: [
    { name: "prompt", kind: "text", required: true, schema: { type: "string", minLength: 1 } },
    { name: "options", kind: "json", required: false, schema: { type: "object" } },
  ] },
  output: { agent_context: "none", fields: [
    { name: "picture", kind: "media", required: true, produces: ["image/png"], cardinality: { min: 1, max: 1 } },
    { name: "facts", kind: "json", required: true, schema: { type: "object" } },
  ] },
};

function png(width = 640, height = 512): Buffer {
  const value = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value, 0);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

function client(bytes: Buffer, over: Record<string, unknown> = {}): MmpClient {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    capabilities: async () => ({ protocol_version: "3.0", capabilities: [{ capability: CAPABILITY, nodes: ["n1"] }] }),
    run: vi.fn(async () => ({
      job_id: "n1-job", type: CAPABILITY.id, status: "done", media_ids: {}, cached: false,
      source: { tier: "gpu", engine: "test-engine", engine_version: "1", generated_at: "2026-10-13T00:00:00Z", degraded: false },
      outputs: {
        picture: { kind: "media", content_type: "image/png", bytes: bytes.length, sha256: digest, delivered: true },
        facts: { kind: "json", value: { width: 640, height: 512, seed: 7 } },
      },
      usage: { served_from: "compute", tier: "gpu", engine: "test-engine", compute_ms: 123, wasted_ms: 0 },
      ...over,
    })),
  } as unknown as MmpClient;
}

const pending = {
  id: "aat_generated", sessionId: "s1", r2Key: "agent-attachments/aat_generated/picture.png",
  fileName: "picture.png", mimeType: "image/png", mediaKind: "image", fileSize: 50 * 1024 * 1024,
  status: "pending" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  attachmentMocks.create.mockResolvedValue(pending);
  attachmentMocks.ready.mockImplementation(async (_id, _session, _user, size, sourceMetadata) => ({ ...pending, status: "ready", fileSize: size, sourceMetadata }));
  attachmentMocks.remove.mockResolvedValue(true);
  r2Mocks.put.mockReturnValue({ url: "https://r2.test/put", contentType: "image/png" });
  const bytes = png();
  r2Mocks.head.mockResolvedValue({ size: bytes.length, contentType: "image/png" });
  r2Mocks.get.mockResolvedValue({ body: bytes, contentType: "image/png" });
});

async function execute(mmpClient = client(png())) {
  return runMmpCapability({ capability: CAPABILITY, rawArguments: { prompt: "纸雕鲸鱼", options: { seed: 7 } },
    resolveMedia: vi.fn(), userId: "u1", productionId: null, sessionId: "s1", runId: "r1", toolCallId: "c1" }, { client: mmpClient });
}

describe("MMP 生成媒体受控回传", () => {
  it("delivery 由 PM 签发，逐项核对字节、PNG、尺寸和 digest 后才登记 ready", async () => {
    const mmpClient = client(png());
    const result = await execute(mmpClient);
    const request = vi.mocked(mmpClient.run).mock.calls[0][0];
    expect(request).toMatchObject({ type: CAPABILITY.id, arguments: { prompt: "纸雕鲸鱼", options: { seed: 7 } },
      delivery: { picture: { url: "https://r2.test/put", headers: { "Content-Type": "image/png" } } } });
    expect(JSON.stringify(request)).not.toMatch(/base64|r2Key|attachmentId/);
    expect(attachmentMocks.ready).toHaveBeenCalledWith("aat_generated", "s1", "u1", 24,
      expect.objectContaining({ capabilityId: CAPABILITY.id, jobId: "n1-job", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), width: 640, height: 512 }));
    expect(result).toMatchObject({ attachments: [{ id: "aat_generated", status: "ready" }],
      media: [{ type: "image", attachmentId: "aat_generated", mimeType: "image/png" }] });
    expect(result.text).toContain("attachmentId=aat_generated");
    expect(usageMocks.record).toHaveBeenCalledWith(expect.objectContaining({ type: CAPABILITY.id, tier: "gpu", computeMs: 123 }));
  });

  it("digest 不符不产生 ready 附件，并进入可靠删除队列", async () => {
    const mmpClient = client(png(), { outputs: {
      picture: { kind: "media", content_type: "image/png", bytes: 24, sha256: "0".repeat(64), delivered: true },
      facts: { kind: "json", value: { width: 640, height: 512 } },
    } });
    await expect(execute(mmpClient)).rejects.toThrow("digest 校验失败");
    expect(attachmentMocks.ready).not.toHaveBeenCalled();
    expect(attachmentMocks.remove).toHaveBeenCalledWith("aat_generated", "s1", "u1");
  });

  it("数据库 finalize 失败时不伪造成功，并清理已经写入的对象", async () => {
    attachmentMocks.ready.mockRejectedValueOnce(new Error("db down"));
    await expect(execute()).rejects.toThrow("db down");
    expect(attachmentMocks.remove).toHaveBeenCalledWith("aat_generated", "s1", "u1");
  });
});
