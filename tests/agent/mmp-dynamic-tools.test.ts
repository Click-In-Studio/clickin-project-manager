import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Capability, MmpClient } from "@mmp/client";
import { buildMmpToolSurface, capabilityParameters, mmpCapabilityToolName } from "@/lib/agent/runtime/mmp-tools";
import { runMmpCapability } from "@/lib/mmp/capability-runner";

const bridgeMocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/agent/tools/mmp-capability-tools", () => ({ runCapability: bridgeMocks.run }));

const textField = { name: "prompt", kind: "text" as const, required: true, description: "提示词", schema: { type: "string", minLength: 1, maxLength: 4000 } };
const jsonField = { name: "options", kind: "json" as const, required: false, description: "限制参数", schema: { type: "object", properties: { seed: { type: "integer", minimum: 0 } }, additionalProperties: false } };
const mediaField = { name: "references", kind: "media" as const, required: true, description: "参考图", accepts: ["image/*"] as [string], cardinality: { min: 1, max: 3 } };
const pngOutput = { name: "result", kind: "media" as const, required: true, produces: ["image/png"] as [string], cardinality: { min: 1, max: 1 } };

const capability = (id: string, fields: Capability["input"]["fields"], outputs: Capability["output"]["fields"] = [pngOutput]): Capability => ({
  id, visibility: "public", purpose: id, description: `${id} test`,
  tiers: [{ tier: "gpu", engine: "test", engine_version: "1", cost: "high", latency_hint: "~30s" }],
  input: { fields }, output: { fields: outputs, agent_context: "none" },
});

const TEXT_MEDIA = capability("image.generate", [textField]);

function registry(capabilities = [TEXT_MEDIA]) {
  return { protocol_version: "3.0", capabilities: capabilities.map((item) => ({ capability: item, nodes: ["n1"] as [string] })) };
}

function runHandle() {
  return { runId: "r1", sessionId: "s1", signal: new AbortController().signal, publish: vi.fn(),
    setStatus: vi.fn(), isDetached: () => false };
}

beforeEach(() => {
  vi.clearAllMocks();
  bridgeMocks.run.mockResolvedValue({ text: "done", attachments: [], media: [] });
});

describe("MMP v3 capability binder", () => {
  it("同一个 binder 从 capability 生成 text→media、text+json→media+json、(text,media[])→media 三种参数", () => {
    const textOnly = capabilityParameters(TEXT_MEDIA) as { properties: Record<string, unknown>; required: string[] };
    const constrained = capabilityParameters(capability("image.generate.options", [textField, jsonField], [pngOutput,
      { name: "metadata", kind: "json", required: true, schema: { type: "object" } }])) as { properties: Record<string, unknown>; required: string[] };
    const editing = capabilityParameters(capability("image.edit", [textField, mediaField])) as {
      properties: Record<string, { type?: string; minItems?: number; maxItems?: number }>;
      required: string[];
    };
    expect(textOnly.required).toEqual(["prompt"]);
    expect(textOnly.properties.prompt).toMatchObject({ type: "string", minLength: 1, maxLength: 4000 });
    expect(constrained.properties.options).toMatchObject({ type: "object", properties: { seed: { type: "integer", minimum: 0 } } });
    expect(editing.properties.references).toMatchObject({ type: "array", minItems: 1, maxItems: 3 });
    expect(JSON.stringify([textOnly, constrained, editing])).not.toContain("image.generate");
  });

  it("每项 capability 只生成一个一级工具，参数原名交给通用授权壳", async () => {
    const client = { capabilities: async () => registry() } as unknown as MmpClient;
    const surface = await buildMmpToolSurface({ userId: "u", productionId: "p", run: runHandle() }, { client });
    expect(surface.tools.map((tool) => tool.mcpName)).toEqual(["mmp.image.generate"]);
    expect(surface.catalog[0]).toMatchObject({ family: "mmp.image.generate", scope: "personal" });
    await surface.tools[0].execute("call-1", { prompt: "纸雕鲸鱼" }, new AbortController().signal);
    expect(bridgeMocks.run).toHaveBeenCalledWith(expect.objectContaining({
      capability: TEXT_MEDIA, rawArguments: { prompt: "纸雕鲸鱼" }, runId: "r1", toolCallId: "call-1",
    }));
  });

  it("长 capability id 的暴露名不超过常见 64 字符限制且保持稳定", () => {
    const id = `very_long_${"x".repeat(64)}`;
    const a = mmpCapabilityToolName(id);
    expect(`clickin__${a.replace(/[^A-Za-z0-9_-]/g, "-")}`.length).toBeLessThanOrEqual(64);
    expect(mmpCapabilityToolName(id)).toBe(a);
    expect(mmpCapabilityToolName(`${id}y`)).not.toBe(a);
  });

  it("registry discovery 失败只撤下动态能力面", async () => {
    const client = { capabilities: async () => { throw new Error("offline"); } } as unknown as MmpClient;
    await expect(buildMmpToolSurface({ userId: "u", productionId: null, run: runHandle() }, { client }))
      .resolves.toEqual({ tools: [], catalog: [], capabilities: [] });
  });

  it("未接入的 audio media output 明确失败，不序列化成文本成功", async () => {
    const audio = capability("audio.generate", [textField], [
      { name: "audio", kind: "media", required: true, produces: ["audio/wav"], cardinality: { min: 1, max: 1 } },
    ]);
    const client = { capabilities: async () => registry([audio]) } as unknown as MmpClient;
    await expect(runMmpCapability({ capability: audio, rawArguments: { prompt: "music" }, resolveMedia: vi.fn(),
      userId: "u", productionId: null, sessionId: "s", runId: "r", toolCallId: "c" }, { client }))
      .rejects.toThrow("尚未接入 audio 的输出渲染");
  });
});
