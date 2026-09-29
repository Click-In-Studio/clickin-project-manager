// 每个 agent_run 从 MMP registry 生成一组一级工具。模型看到的是具体 capability，
// 不是带 capability 枚举的“工具路由工具”；附件/资产两种入口在服务端仍共用稳定权限壳。

import { createHash } from "node:crypto";
import type { Capability, MmpClient } from "@mmp/client";
import type { TSchema } from "typebox";
import type { AgentToolResult } from "../../../vendor/openclaw/packages/agent-core/src/types";
import type { ToolCatalogEntry } from "@/lib/agent/tools/tool-catalog";
import { getMmpClient } from "@/lib/mmp/client";
import { exposedName, type RuntimeToolDef, type ToolContext } from "./tools";

export type MmpToolSurface = {
  tools: RuntimeToolDef[];
  catalog: ToolCatalogEntry[];
  capabilities: Capability[];
};

const text = (value: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text: value }], details: undefined });

export function mmpCapabilityToolName(scope: "attachment" | "asset", capabilityId: string): string {
  const prefix = `mmp.${scope}.`;
  const maxMcpLength = 55; // exposedName 会再加 9 字符 clickin__；兼容常见 64 字符函数名上限。
  if (prefix.length + capabilityId.length <= maxMcpLength) return prefix + capabilityId;
  const hash = createHash("sha256").update(capabilityId).digest("hex").slice(0, 8);
  return `${prefix}${capabilityId.slice(0, maxMcpLength - prefix.length - hash.length - 1)}_${hash}`;
}

function paramsSchema(capability: Capability, target: "attachmentId" | "assetId"): TSchema {
  const tiers = [...new Set(capability.tiers.map((item) => item.tier))];
  const schema = capability.input.params_schema ?? { type: "object", additionalProperties: false };
  return {
    type: "object",
    properties: {
      [target]: { type: "string", minLength: 1, description: target === "attachmentId" ? "当前会话临时附件 id" : "当前制作资产 id" },
      ...(tiers.length > 1
        ? { tier: { type: "string", enum: tiers, description: `执行档位；省略使用默认档 ${tiers[0]}` } }
        : {}),
      params: { ...schema, description: "该 MMP capability 的参数；没有需要调整的参数时可省略" },
    },
    required: [target],
    additionalProperties: false,
  } as TSchema;
}

function catalogEntry(
  mcpName: string,
  scope: "personal" | "production",
  capability: Capability,
  targetLabel: string,
): ToolCatalogEntry {
  const description = capability.description?.trim() || `执行 MMP ${capability.id} 能力`;
  const accepts = capability.input.media.accepts.join("、");
  return {
    name: mcpName,
    family: `mmp.${capability.id}`,
    scope,
    oneliner: `${targetLabel}：${description}（${accepts}）`,
    triggers: [description, capability.purpose, capability.id],
    en: `${capability.id} ${capability.purpose} ${description}`,
    examples: [description],
  };
}

function makeTool(
  ctx: ToolContext,
  capability: Capability,
  target: "attachment" | "asset",
): RuntimeToolDef {
  const mcpName = mmpCapabilityToolName(target, capability.id);
  const description = capability.description?.trim() || `执行 MMP ${capability.id} 能力`;
  const tiers = capability.tiers.map((item) => `${item.tier}${item.latency_hint ? ` ${item.latency_hint}` : ""}`).join("、");
  const accepts = capability.input.media.accepts.join("、");
  return {
    mcpName,
    name: exposedName(mcpName),
    label: `${description}（${target === "attachment" ? "附件" : "资产"}）`,
    description: `${description}。处理${target === "attachment" ? "当前会话临时附件" : "当前制作资产"}；接受 ${accepts}；可用档位：${tiers}。`,
    parameters: paramsSchema(capability, target === "attachment" ? "attachmentId" : "assetId"),
    readOnly: true,
    execute: async (_toolCallId, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      const common = {
        capability,
        tier: typeof args.tier === "string" ? args.tier : undefined,
        params: args.params && typeof args.params === "object" && !Array.isArray(args.params)
          ? args.params as Record<string, unknown>
          : undefined,
        signal: ctx.run?.signal,
      };
      if (target === "attachment") {
        const out = await (await import("@/lib/agent/tools/mmp-capability-tools")).runAttachmentCapability(
          ctx.userId, ctx.productionId, ctx.run?.sessionId ?? null, String(args.attachmentId ?? ""), common,
        );
        return text(out);
      }
      if (!ctx.productionId) return text("该工具仅在关联制作的对话中可用。");
      const out = await (await import("@/lib/agent/tools/mmp-capability-tools")).runAssetCapability(
        ctx.userId, ctx.productionId, String(args.assetId ?? ""), common,
      );
      return text(out);
    },
  };
}

/** discovery 失败即撤下动态能力面；普通 Click-In 工具不受影响。 */
export async function buildMmpToolSurface(
  ctx: ToolContext,
  opts: { client?: MmpClient | null } = {},
): Promise<MmpToolSurface> {
  const client = opts.client === undefined ? getMmpClient() : opts.client;
  if (!client) return { tools: [], catalog: [], capabilities: [] };
  try {
    const registry = await client.capabilities();
    const capabilities = registry.capabilities
      .map((entry) => entry.capability)
      .filter((capability) => capability.input.media.presence !== "none");
    const tools: RuntimeToolDef[] = [];
    const catalog: ToolCatalogEntry[] = [];
    for (const capability of capabilities) {
      const attachment = makeTool(ctx, capability, "attachment");
      tools.push(attachment);
      catalog.push(catalogEntry(attachment.mcpName, "personal", capability, "处理会话附件"));
      if (ctx.productionId) {
        const asset = makeTool(ctx, capability, "asset");
        tools.push(asset);
        catalog.push(catalogEntry(asset.mcpName, "production", capability, "处理项目资产"));
      }
    }
    return { tools, catalog, capabilities };
  } catch (error) {
    console.warn(`[mmp] 动态 capability discovery 失败，撤下本 run 的 MMP 工具面：${error instanceof Error ? error.message : String(error)}`);
    return { tools: [], catalog: [], capabilities: [] };
  }
}
