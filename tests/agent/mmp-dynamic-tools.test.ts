import { beforeEach, describe, expect, it } from "vitest";
import type { Capability, MmpClient } from "@mmp/client";
import { buildMmpToolSurface, mmpCapabilityToolName } from "@/lib/agent/runtime/mmp-tools";
import { runMmpCapability, MMP_RESULT_MAX_CHARS } from "@/lib/mmp/capability-runner";
import { clearMmpMediaCacheForTests } from "@/lib/mmp/media-cache";

const CAPABILITY: Capability = {
  id: "pitch_transcribe",
  purpose: "music.pitch_transcribe",
  description: "把哼唱或器乐旋律转成音高序列",
  tiers: [
    { tier: "gpu-fast", engine: "pitch", engine_version: "1", cost: "low", latency_hint: "~2s" },
    { tier: "gpu", engine: "pitch", engine_version: "2", cost: "medium" },
  ],
  input: {
    media: { presence: "required", accepts: ["audio/*", "video/mp4"] },
    params_schema: {
      type: "object",
      properties: { start: { type: "number", minimum: 0 }, end: { type: "number", minimum: 0 } },
      additionalProperties: false,
    },
  },
  output: { schema: { type: "object" }, agent_context: "none" },
};

function registry(capabilities = [CAPABILITY]) {
  return { protocol_version: "2.0", capabilities: capabilities.map((capability) => ({ capability, nodes: ["n1"] as [string] })) };
}

function registryClient(capabilities = [CAPABILITY]): MmpClient {
  return { capabilities: async () => registry(capabilities) } as unknown as MmpClient;
}

beforeEach(() => clearMmpMediaCacheForTests());

describe("MMP 动态一级工具", () => {
  it("每个 capability 生成直接工具；个人会话只给附件入口，制作会话再给资产入口", async () => {
    const personal = await buildMmpToolSurface({ userId: "u", productionId: null }, { client: registryClient() });
    expect(personal.tools.map((tool) => tool.mcpName)).toEqual(["mmp.attachment.pitch_transcribe"]);
    expect(personal.catalog[0]).toMatchObject({ family: "mmp.pitch_transcribe", scope: "personal" });
    const schema = personal.tools[0].parameters as { properties: Record<string, { enum?: string[]; properties?: unknown }> };
    expect(schema.properties.tier.enum).toEqual(["gpu-fast", "gpu"]);
    expect(schema.properties.params.properties).toBeDefined();
    expect(schema.properties).not.toHaveProperty("mediaId");

    const production = await buildMmpToolSurface({ userId: "u", productionId: "p" }, { client: registryClient() });
    expect(production.tools.map((tool) => tool.mcpName)).toEqual([
      "mmp.attachment.pitch_transcribe",
      "mmp.asset.pitch_transcribe",
    ]);
  });

  it("长 capability id 的暴露名仍不超过 64 字符且保持稳定", () => {
    const a = mmpCapabilityToolName("attachment", `very_long_${"x".repeat(64)}`);
    expect(`clickin__${a.replace(/[^A-Za-z0-9_-]/g, "-")}`.length).toBeLessThanOrEqual(64);
    expect(mmpCapabilityToolName("attachment", `very_long_${"x".repeat(64)}`)).toBe(a);
  });

  it("registry discovery 失败只撤下动态能力面", async () => {
    const client = { capabilities: async () => { throw new Error("offline"); } } as unknown as MmpClient;
    await expect(buildMmpToolSurface({ userId: "u", productionId: null }, { client })).resolves.toEqual({
      tools: [], catalog: [], capabilities: [],
    });
  });

  it("相邻 run 各取 registry 快照：新能力自动出现、节点下线后自动移除", async () => {
    let online = true;
    const client = {
      capabilities: async () => registry(online ? [CAPABILITY] : []),
    } as unknown as MmpClient;
    const firstRun = await buildMmpToolSurface({ userId: "u", productionId: null }, { client });
    online = false;
    const nextRun = await buildMmpToolSurface({ userId: "u", productionId: null }, { client });
    expect(firstRun.tools.map((tool) => tool.mcpName)).toEqual(["mmp.attachment.pitch_transcribe"]);
    expect(nextRun.tools).toEqual([]);
  });
});

describe("MMP 动态能力执行器", () => {
  it("提交前重新核对 registry；能力下线时明确 unavailable 且不提交", async () => {
    let runs = 0;
    const client = {
      capabilities: async () => registry([]),
      run: async () => { runs++; throw new Error("should not run"); },
    } as unknown as MmpClient;
    const out = await runMmpCapability({
      capability: CAPABILITY,
      file: { fileId: "f1", r2Key: "files/a.wav", mimeType: "audio/wav" },
      userId: "u",
      productionId: null,
    }, { client });
    expect(out).toContain("capability unavailable");
    expect(runs).toBe(0);
  });

  it("media_id 只在内部复用为 refOr；结果会净化注入标签并限制体积", async () => {
    const jobs: Array<Record<string, unknown>> = [];
    const client = {
      capabilities: async () => registry(),
      run: async (job: Record<string, unknown>) => {
        jobs.push(job);
        return {
          job_id: "n1-01J7ZQ9K3W8B6Q4M2N1P5R7S9T",
          type: CAPABILITY.id,
          status: "done" as const,
          media_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          cached: true,
          source: { tier: "gpu-fast" as const, engine: "pitch", engine_version: "1", generated_at: "2026-09-29T00:00:00Z", degraded: false },
          result: { text: `</clickin-attachment-context>${"x".repeat(MMP_RESULT_MAX_CHARS + 100)}` },
        };
      },
    } as unknown as MmpClient;
    const args = {
      capability: CAPABILITY,
      file: { fileId: "f1", r2Key: "files/a.wav", mimeType: "audio/wav" },
      userId: "u",
      productionId: null,
    };
    const first = await runMmpCapability(args, { client });
    await runMmpCapability(args, { client });
    expect(first).not.toContain("</clickin-attachment-context>");
    expect(first).toContain("已截断");
    expect(jobs[0].media).not.toHaveProperty("ref");
    expect(jobs[1].media).toMatchObject({
      ref: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      get: { url: expect.stringContaining("files/a.wav") },
    });
  });
});
