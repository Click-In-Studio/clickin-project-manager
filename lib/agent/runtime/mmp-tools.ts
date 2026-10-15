// 每个 agent_run 从 MMP v3 registry 生成一级工具。输入字段和输出说明完全来自
// capability；新增 capability 不需要在 Click-In 增加 id 映射或手写工具。

import { createHash } from "node:crypto";
import type { Capability, MmpClient } from "@mmp/client";
import type { TSchema } from "typebox";
import type { AgentToolResult } from "../../../vendor/openclaw/packages/agent-core/src/types";
import type { ToolCatalogEntry } from "@/lib/agent/tools/tool-catalog";
import { getMmpClient } from "@/lib/mmp/client";
import { exposedName, type RuntimeToolDef, type ToolContext } from "./tools";

export type MmpToolSurface = { tools: RuntimeToolDef[]; catalog: ToolCatalogEntry[]; capabilities: Capability[] };

export function mmpCapabilityToolName(capabilityId: string): string {
  const prefix = "mmp.";
  const maxMcpLength = 55;
  if (prefix.length + capabilityId.length <= maxMcpLength) return prefix + capabilityId;
  const hash = createHash("sha256").update(capabilityId).digest("hex").slice(0, 8);
  return `${prefix}${capabilityId.slice(0, maxMcpLength - prefix.length - hash.length - 1)}_${hash}`;
}

const mediaReferenceSchema = {
  oneOf: [
    { type: "object", properties: { attachmentId: { type: "string", minLength: 1, description: "当前会话附件 id" } }, required: ["attachmentId"], additionalProperties: false },
    { type: "object", properties: { assetId: { type: "string", minLength: 1, description: "当前制作资产 id" } }, required: ["assetId"], additionalProperties: false },
  ],
};

export function capabilityParameters(capability: Capability): TSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of capability.input.fields) {
    if (field.kind === "media") {
      properties[field.name] = field.cardinality.max === 1
        ? { ...mediaReferenceSchema, description: field.description ?? `媒体输入；接受 ${field.accepts.join("、")}` }
        : { type: "array", items: mediaReferenceSchema, minItems: field.cardinality.min, maxItems: field.cardinality.max,
          description: field.description ?? `媒体输入；接受 ${field.accepts.join("、")}` };
    } else properties[field.name] = { ...field.schema, ...(field.description ? { description: field.description } : {}) };
    if (field.required) required.push(field.name);
  }
  const tiers = [...new Set(capability.tiers.map((item) => item.tier))];
  if (tiers.length > 1) properties.tier = { type: "string", enum: tiers, description: `执行档位；省略使用默认档 ${tiers[0]}` };
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false } as TSchema;
}

function outputDescription(capability: Capability): string {
  return capability.output.fields.map((field) => {
    if (field.kind === "media") return `${field.name}: media(${field.produces.join("|")}, ${field.cardinality.min}–${field.cardinality.max})`;
    return `${field.name}: ${field.kind}`;
  }).join("；") || "无命名输出";
}

function catalogEntry(mcpName: string, capability: Capability): ToolCatalogEntry {
  const description = capability.description?.trim() || `执行 MMP ${capability.id} 能力`;
  return { name: mcpName, family: `mmp.${capability.id}`, scope: "personal", oneliner: description,
    triggers: [description, capability.purpose, capability.id], en: `${capability.id} ${capability.purpose} ${description}`, examples: [description] };
}

function makeTool(ctx: ToolContext, capability: Capability): RuntimeToolDef {
  const mcpName = mmpCapabilityToolName(capability.id);
  const description = capability.description?.trim() || `执行 MMP ${capability.id} 能力`;
  const tiers = capability.tiers.map((item) => `${item.tier}${item.latency_hint ? ` ${item.latency_hint}` : ""}`).join("、");
  return {
    mcpName,
    name: exposedName(mcpName),
    label: description,
    description: `${description}。输入与限制来自在线 capability；输出：${outputDescription(capability)}；可用档位：${tiers}。`
      + (capability.output.fields.some((field) => field.kind === "media")
        ? "生成媒体附件后，应调用 my.attachment_rename 按内容与用途命名，保留原扩展名，避免交付一批同名文件。" : ""),
    parameters: capabilityParameters(capability),
    readOnly: true,
    execute: async (toolCallId, raw, _signal, onUpdate) => {
      if (!ctx.run) throw new Error("当前运行没有持久化会话上下文，不能执行 MMP 任务");
      const args = { ...((raw ?? {}) as Record<string, unknown>) };
      const tier = typeof args.tier === "string" ? args.tier : undefined;
      delete args.tier;
      const out = await (await import("@/lib/agent/tools/mmp-capability-tools")).runCapability({
        userId: ctx.userId, productionId: ctx.productionId, sessionId: ctx.run.sessionId,
        runId: ctx.run.runId, toolCallId, capability, rawArguments: args, tier,
        signal: ctx.run.signal,
        onStatus: (status) => {
          const detail = status.status === "queued"
            ? `排队中${status.queuePosition ? `（前方 ${status.queuePosition} 个任务）` : ""}`
            : `生成中${status.etaSec ? `（预计 ${status.etaSec} 秒）` : ""}`;
          onUpdate?.({ content: [], details: status, progress: { text: detail, visibility: "channel", privacy: "public", id: "mmp-status" } });
        },
      });
      await ctx.run.warmAttachments?.(out.attachments.map((item) => item.id));
      return {
        content: [{ type: "text" as const, text: out.text }, ...out.media],
        details: { attachments: out.attachments.map((item) => ({ attachmentId: item.id, fileName: item.fileName,
          mimeType: item.mimeType, fileSize: item.fileSize, source: item.sourceMetadata })) },
      } satisfies AgentToolResult<unknown>;
    },
  };
}

/** discovery 失败即撤下动态能力面；普通 Click-In 工具不受影响。 */
export async function buildMmpToolSurface(ctx: ToolContext, opts: { client?: MmpClient | null } = {}): Promise<MmpToolSurface> {
  const client = opts.client === undefined ? getMmpClient() : opts.client;
  if (!client) return { tools: [], catalog: [], capabilities: [] };
  try {
    const registry = await client.capabilities();
    const capabilities = registry.capabilities.map((entry) => entry.capability)
      // 交付是宿主协议步骤；模型只使用已授权的附件/资产引用，不接触 ref 或 PUT 地址。
      .filter((capability) => capability.purpose !== "media.deliver");
    const tools = capabilities.map((capability) => makeTool(ctx, capability));
    return { tools, catalog: capabilities.map((capability, index) => catalogEntry(tools[index].mcpName, capability)), capabilities };
  } catch (error) {
    console.warn(`[mmp] 动态 capability discovery 失败，撤下本 run 的 MMP 工具面：${error instanceof Error ? error.message : String(error)}`);
    return { tools: [], catalog: [], capabilities: [] };
  }
}
