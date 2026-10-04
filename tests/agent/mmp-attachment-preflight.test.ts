import { beforeEach, describe, expect, it, vi } from "vitest";
import { MmpClient, type CapabilitiesResponse, type Capability } from "@mmp/client";
import {
  capabilityContentType,
  clearAttachmentPreflightCacheForTests,
  preflightAttachment,
  preflightAttachments,
  renderPreflightUnavailable,
  resolveTriageCapability,
} from "@/lib/mmp/attachment-preflight";

const usageMocks = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/mmp/usage-db", () => ({ recordMmpUsage: usageMocks.record }));

type Call = { url: string; body: Record<string, unknown> | null };

const capability = (
  id: string,
  purpose: string,
  accepts: string[],
  agentContext: "required" | "optional" | "none" = "required",
): Capability => ({
  id,
  purpose,
  description: `${id} test`,
  tiers: [{ tier: "cpu", engine: `${id}-test`, engine_version: "1", cost: "low" }],
  input: { media: { presence: "required", accepts } },
  output: { schema: "urn:mmp:protocol:2:digest", agent_context: agentContext },
});

const AUDIO_TRIAGE = capability("triage.audio", "triage", ["audio/*"]);
const IMAGE_TRIAGE = capability("triage.image", "triage", ["image/*"]);
const PDF_TRIAGE = capability("triage.pdf", "triage", ["application/pdf"]);
const OCR = capability("ocr.structured", "ocr", ["image/*", "application/pdf"], "none");

function registry(capabilities: Capability[] = [AUDIO_TRIAGE, IMAGE_TRIAGE, OCR]): CapabilitiesResponse {
  return {
    protocol_version: "2.0",
    capabilities: capabilities.map((entry) => ({ capability: entry, nodes: ["test-node"] })),
  };
}

function fakeClient(capabilities: Capability[] = [AUDIO_TRIAGE, IMAGE_TRIAGE, OCR]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.endsWith("/capabilities")) return Response.json(registry(capabilities));
    const task = String(body?.type ?? "");
    const source = {
      tier: "cpu", engine: `${task}-test`, engine_version: "1", generated_at: "2026-09-29T00:00:00Z",
      degraded: false, params: {},
    };
    return Response.json({
      job_id: "test-node-01", type: task, status: "done", media_id: `sha256:${task}`, cached: false, source,
      result: { kind: task === "triage.audio" ? "audio" : "image" },
      usage: { served_from: "compute", tier: "cpu", engine: `${task}-test`, compute_ms: 17, wasted_ms: 99 },
      timings_ms: { vad: 3, tagging: 4, asr: 5 },
      agent_context: {
        format: "mmp-agent-context-v1",
        content_type: "text/plain; charset=utf-8",
        text: `[mmp:agent-context start]\n${task}：测试内容\n[mmp:agent-context end]`,
      },
    });
  }) as unknown as typeof globalThis.fetch;
  return { client: new MmpClient({ baseUrl: "https://mmp.test", fetch, retries: 0 }), calls };
}

beforeEach(() => {
  clearAttachmentPreflightCacheForTests();
  vi.clearAllMocks();
});

describe("MMP 2.0 自动预检能力发现", () => {
  it("只用 purpose + Content-Type 解析唯一能力，不解释任务 id 或本地模态", () => {
    const available = registry();
    expect(resolveTriageCapability(available, "audio/mp4")?.id).toBe("triage.audio");
    expect(resolveTriageCapability(available, "video/mp4")).toBeNull();
    expect(resolveTriageCapability(available, "image/webp")?.id).toBe("triage.image");
    expect(resolveTriageCapability(available, "application/pdf")).toBeNull();
    expect(resolveTriageCapability(available, "text/plain")).toBeNull();
  });

  it("只纠正上传入口已确认的语义 MIME，不在宿主映射任务", () => {
    expect(capabilityContentType({ mediaKind: "audio", mimeType: "video/mp4" })).toBe("audio/mp4");
    expect(capabilityContentType({ mediaKind: "image", mimeType: "image/png; charset=binary" })).toBe("image/png");
    expect(capabilityContentType({ mediaKind: null, mimeType: "application/pdf" })).toBe("application/pdf");
  });

  it("Safari video/mp4 录音由 MMP 选中音频预检，并原样透传 agent_context", async () => {
    const { client, calls } = fakeClient();
    const result = await preflightAttachment({
      attachmentId: "aat_audio", mediaKind: "audio", mimeType: "video/mp4", r2Key: "attachments/audio.mp4",
    }, { client });
    expect(result).toMatchObject({ status: "ok", capabilityId: "triage.audio" });
    expect(result.contextText).toBe("[mmp:agent-context start]\ntriage.audio：测试内容\n[mmp:agent-context end]");
    const job = calls.find((call) => call.url.endsWith("/jobs"))?.body;
    expect(job?.type).toBe("triage.audio");
    expect(job?.media).toMatchObject({ get: { url: expect.stringContaining("attachments/audio.mp4") }, content_type: "video/mp4" });
  });

  it("预检记账只取 usage.compute_ms，不叠加 wasted_ms 或旧 timings", async () => {
    const { client } = fakeClient();
    await preflightAttachment({
      attachmentId: "aat_usage", mediaKind: "audio", mimeType: "audio/mp4", r2Key: "attachments/usage.mp4",
    }, { client, usage: { userId: "u1", productionId: null } });
    expect(usageMocks.record).toHaveBeenCalledWith({
      userId: "u1", productionId: null, type: "triage.audio", tier: "cpu", computeMs: 17,
    });
  });

  it("当前只预检图片，PDF 没有专属 triage 时不误入图片通道", async () => {
    const { client, calls } = fakeClient();
    const results = await preflightAttachments([
      { attachmentId: "i1", mimeType: "image/png", r2Key: "i" },
      { attachmentId: "p1", mimeType: "application/pdf", r2Key: "p" },
    ], { client });
    expect(Object.values(results).map((result) => result.status === "ok" && result.capabilityId)).toEqual(["triage.image"]);
    expect(calls.filter((call) => call.url.endsWith("/jobs")).map((call) => call.body?.type)).toEqual([
      "triage.image",
    ]);
  });

  it("未来 MMP 注册 PDF triage 后无需宿主映射即可自动接入", async () => {
    const { client, calls } = fakeClient([AUDIO_TRIAGE, IMAGE_TRIAGE, PDF_TRIAGE, OCR]);
    const results = await preflightAttachments([
      { attachmentId: "p1", mimeType: "application/pdf", r2Key: "p" },
    ], { client });
    expect(results.p1).toMatchObject({ status: "ok", capabilityId: "triage.pdf" });
    expect(calls.find((call) => call.url.endsWith("/jobs"))?.body?.type).toBe("triage.pdf");
  });

  it("同一条消息共享一次 registry discovery，不匹配的普通附件不注入伪预检", async () => {
    const { client, calls } = fakeClient();
    const results = await preflightAttachments([
      { attachmentId: "a1", mimeType: "audio/mp4", r2Key: "a" },
      { attachmentId: "a2", mimeType: "audio/mpeg", r2Key: "b" },
      { attachmentId: "t1", mimeType: "text/plain", r2Key: "t" },
    ], { client });
    expect(Object.keys(results).sort()).toEqual(["a1", "a2"]);
    expect(calls.filter((call) => call.url.endsWith("/capabilities"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/jobs"))).toHaveLength(2);
  });

  it("显式预检没有匹配能力时说明 unavailable，且不提交任务", async () => {
    const { client, calls } = fakeClient([]);
    const result = await preflightAttachment({
      attachmentId: "v1", mimeType: "video/mp4", r2Key: "v",
    }, { client });
    expect(result).toMatchObject({ status: "unavailable", reason: expect.stringContaining("原件仍可用") });
    expect(result.contextText).toContain("未获得 MMP 媒体预检结果（unsupported_type）");
    expect(calls.some((call) => call.url.endsWith("/jobs"))).toBe(false);
  });

  it("宿主降级块只陈述不可用，不伪造 digest", () => {
    const block = renderPreflightUnavailable("no_node");
    expect(block).toContain("Click-In 未获得 MMP 媒体预检结果");
    expect(block).toContain("不能据此判断附件内容");
    expect(block).not.toContain("[mmp:");
  });
});
