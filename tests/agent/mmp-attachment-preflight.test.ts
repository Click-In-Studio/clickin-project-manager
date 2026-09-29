import { beforeEach, describe, expect, it } from "vitest";
import { MmpClient, type Capability } from "@mmp/client";
import {
  clearAttachmentPreflightCacheForTests,
  matchingTriageCapabilities,
  modalityOf,
  preflightAttachment,
  preflightAttachments,
} from "@/lib/mmp/attachment-preflight";

type Call = { url: string; body: Record<string, unknown> | null };

const AUDIO_TRIAGE: Capability = {
  id: "triage.audio",
  modal: "audio",
  description: "音频预检",
  tiers: [{ tier: "cpu", engine: "audio-test", engine_version: "1", cost: "low" }],
  input: { media: "required" },
  output_schema: "urn:mmp:protocol:1:digest",
};

function fakeClient(capabilities: Capability[] = [AUDIO_TRIAGE]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.endsWith("/capabilities")) {
      return Response.json({
        protocol_version: "1.1",
        capabilities: capabilities.map((capability) => ({ capability, nodes: ["test-node"] })),
      });
    }
    const source = {
      tier: "cpu", engine: "audio-test", engine_version: "1", generated_at: "2026-09-29T00:00:00Z",
      degraded: false, params: {},
    };
    return Response.json({
      job_id: "test-node-01", type: "triage.audio", status: "done", media_id: "sha256:audio", cached: false, source,
      result: {
        media_id: "sha256:audio", kind: "audio", duration_sec: 2.5, timeline_unit: "sec",
        segments: [{ start: 0, end: 2.5, label_status: "ok", labels: [{ tag: "Speech", score: 0.9 }], asr: { text: "测试语音", lang: "zh", confidence: 0.9 } }],
        tools: { vad: "ok", asr: "ok" }, gaps: [], capabilities_available: [], source,
      },
    });
  }) as unknown as typeof globalThis.fetch;
  return { client: new MmpClient({ baseUrl: "https://mmp.test", fetch, retries: 0 }), calls };
}

beforeEach(() => clearAttachmentPreflightCacheForTests());

describe("MMP 自动预检能力发现", () => {
  it("只选择 MMP 注册表中模态匹配的 triage.*，不维护本地任务映射", () => {
    const image = { ...AUDIO_TRIAGE, id: "triage.image", modal: "image" as const };
    const explicit = { ...AUDIO_TRIAGE, id: "pitch_transcribe" };
    expect(matchingTriageCapabilities([AUDIO_TRIAGE, image, explicit], "audio").map((c) => c.id))
      .toEqual(["triage.audio"]);
  });

  it("上传端 mediaKind 优先于 MIME，Safari video/mp4 录音仍匹配 audio", async () => {
    expect(modalityOf({ mediaKind: "audio", mimeType: "video/mp4", fileName: "录音.mp4" })).toBe("audio");
    const { client, calls } = fakeClient();
    const result = await preflightAttachment({
      mediaKind: "audio", attachmentId: "aat_audio", fileName: "录音.mp4", mimeType: "video/mp4", r2Key: "attachments/audio.mp4",
    }, { client });
    expect(result.status).toBe("ok");
    expect(result.renderedDigest).toContain("测试语音");
    const job = calls.find((call) => call.url.endsWith("/jobs"))?.body;
    expect(job?.type).toBe("triage.audio");
    expect(job?.media).toMatchObject({ get: { url: expect.stringContaining("attachments/audio.mp4") }, content_type: "video/mp4" });
  });

  it("同一条消息共享一次 capability discovery，普通文本附件不预检", async () => {
    const { client, calls } = fakeClient();
    const results = await preflightAttachments([
      { mediaKind: "audio", attachmentId: "a1", fileName: "a.m4a", mimeType: "audio/mp4", r2Key: "a" },
      { mediaKind: "audio", attachmentId: "a2", fileName: "b.mp3", mimeType: "audio/mpeg", r2Key: "b" },
      { attachmentId: "t1", fileName: "note.txt", mimeType: "text/plain", r2Key: "t" },
    ], { client });
    expect(Object.keys(results).sort()).toEqual(["a1", "a2"]);
    expect(calls.filter((call) => call.url.endsWith("/capabilities"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/jobs"))).toHaveLength(2);
  });

  it("注册表没有匹配 triage 时显式 unavailable，仍保留原件", async () => {
    const { client, calls } = fakeClient([]);
    const result = await preflightAttachment({
      mediaKind: "video", attachmentId: "v1", fileName: "v.mp4", mimeType: "video/mp4", r2Key: "v",
    }, { client });
    expect(result).toMatchObject({ status: "unavailable", reason: expect.stringContaining("原件仍可用") });
    expect(result.renderedDigest).toContain("[mmp:digest unavailable]");
    expect(calls.some((call) => call.url.endsWith("/jobs"))).toBe(false);
  });
});
