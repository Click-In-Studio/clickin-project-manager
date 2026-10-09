import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { Type } from "typebox";
import type { ToolDefinition } from "./tools";
import { SUBAGENT_TOOL_NAMES } from "./subagent-types";
import type { SubagentSource } from "./subagent-types";

const sourceSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  locator: Type.String({ minLength: 1, maxLength: 1000 }),
  content: Type.String({ maxLength: 300_000 }),
});
const idSchema = Type.Object({ subagentId: Type.String({ minLength: 1 }) });
const requireRun = (ctx: Parameters<ToolDefinition["execute"]>[0]) => {
  if (!ctx.run || ctx.run.unattended)
    throw new Error("子 Agent 工具只用于交互主会话");
  return ctx.run;
};

/** 都属于运行时协作动作，不修改业务状态；创建/补充以 toolCallId 幂等，恢复可重放。 */
export const SUBAGENT_DEFS: ToolDefinition[] = [
  {
    mcpName: SUBAGENT_TOOL_NAMES[0],
    readOnly: true,
    description:
      "将长材料研读或边界清楚的调研任务交给独立持久上下文。显式交接来源、任务和完成标准；子 Agent 不查业务库，缺资料会请求你补给。后台完成主动通知，不要轮询。",
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 16000 }),
      context: Type.Optional(Type.String({ maxLength: 24000 })),
      completionCriteria: Type.Optional(Type.String({ maxLength: 4000 })),
      sources: Type.Optional(Type.Array(sourceSchema, { maxItems: 30 })),
    }),
    execute: async (ctx, args, callId) =>
      (await import("./subagents")).spawnSubagent(
        requireRun(ctx),
        args as unknown as {
          task: string;
          context?: string;
          completionCriteria?: string;
          sources?: SubagentSource[];
        },
        callId,
      ),
  },
  {
    mcpName: SUBAGENT_TOOL_NAMES[1],
    readOnly: true,
    description:
      "查看当前会话子 Agent 的状态、最新结果摘要和上下文请求。收到通知后定位任务；不要轮询。",
    parameters: Type.Object({}),
    execute: async (ctx) => {
      const rows = await (
        await import("./subagent-db")
      ).listSubagents(requireRun(ctx).sessionId);
      return neutralizeInjectionTags(
        JSON.stringify(
          rows.map((r) => ({ ...r, result: r.result?.slice(0, 800) ?? null })),
        ),
      );
    },
  },
  {
    mcpName: SUBAGENT_TOOL_NAMES[2],
    readOnly: true,
    description:
      "按游标查看子 Agent 的详细结果、来源与阅读轨迹，用于核对证据。",
    parameters: Type.Object({
      subagentId: Type.String({ minLength: 1 }),
      cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    execute: async (ctx, args) =>
      (await import("./subagents")).readSubagent(
        requireRun(ctx).sessionId,
        String(args.subagentId),
        Number(args.cursor ?? 0),
      ),
  },
  {
    mcpName: SUBAGENT_TOOL_NAMES[3],
    readOnly: true,
    description:
      "给子 Agent 补资料、修正方向或继续追问。已完成也能在原阅读上下文继续；仍在执行时补充按序排队。同名来源不能重复添加。",
    parameters: Type.Object({
      subagentId: Type.String({ minLength: 1 }),
      message: Type.String({ minLength: 1, maxLength: 24000 }),
      sources: Type.Optional(Type.Array(sourceSchema, { maxItems: 30 })),
    }),
    execute: async (ctx, args, callId) =>
      (await import("./subagents")).sendSubagent(
        requireRun(ctx),
        String(args.subagentId),
        String(args.message),
        args.sources as SubagentSource[] | undefined,
        callId,
      ),
  },
  {
    mcpName: SUBAGENT_TOOL_NAMES[4],
    readOnly: true,
    description:
      "等待指定子 Agent 结束或请求上下文；上下文请求会立即返回，先补资料再等，避免互相等待。等待期间不要反复查询列表。",
    parameters: Type.Object({
      subagentIds: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 8,
      }),
      timeoutS: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    }),
    execute: async (ctx, args) => {
      const run = requireRun(ctx);
      return (await import("./subagents")).waitSubagents(
        run.sessionId,
        args.subagentIds as string[],
        Number(args.timeoutS ?? 60),
        run.signal,
      );
    },
  },
  {
    mcpName: SUBAGENT_TOOL_NAMES[5],
    readOnly: true,
    description:
      "停止指定子 Agent，包括其排队轮次；停止后不会再自动唤醒主会话。",
    parameters: idSchema,
    execute: async (ctx, args) => {
      await (
        await import("./subagents")
      ).stopSubagent(requireRun(ctx).sessionId, String(args.subagentId));
      return "子 Agent 已停止。";
    },
  },
];
