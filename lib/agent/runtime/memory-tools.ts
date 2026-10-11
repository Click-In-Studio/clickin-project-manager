import { Type } from "typebox";
import type { ToolDefinition } from "./tools";
import { mutateMemoryEntry, readMemoryScope } from "@/lib/agent/memory/memory-db";

const scope = Type.Union([Type.Literal("general"), Type.Literal("project")]);
export const MEMORY_DEFS: ToolDefinition[] = [
  {
    mcpName: "my.memory_read", readOnly: true,
    description: "查看当前用户的通用或当前项目长期记忆。scope=project 只允许当前会话项目。来源标签只说明写入方式，不证明事实正确。",
    parameters: Type.Object({ scope }),
    execute: async (ctx, args) => {
      if (args.scope === "project" && !ctx.productionId) throw new Error("当前会话没有关联项目");
      return JSON.stringify(await readMemoryScope(ctx.userId, args.scope === "project" ? ctx.productionId : null));
    },
  },
  {
    mcpName: "my.memory_write", readOnly: false, unattended: "deny",
    description: "记录用户明确表达的持续协作要求或已确认决定。项目要求必须 scope=project；不得把单项目要求升级为通用偏好、保存人格推断、助手建议或未经验证的结论。先 memory_read，同一事实更新已有 id，不能创造矛盾副本。id/revision 缺省表示新建。只写主动记忆，不可替用户确认、删除或覆盖用户编辑。当前指令与业务事实优先。",
    parameters: Type.Object({ scope, body: Type.String({ minLength: 1, maxLength: 1000 }),
      id: Type.Optional(Type.String()), revision: Type.Optional(Type.Integer({ minimum: 0 })) }),
    mutates: args => ({ scope: "memory", action: args.id ? "updated" : "created", ids: args.id ? [String(args.id)] : undefined }),
    execute: async (ctx, args) => {
      if (args.scope === "project" && !ctx.productionId) throw new Error("当前会话没有关联项目");
      const id = await mutateMemoryEntry(ctx.userId, args.scope === "project" ? ctx.productionId : null, {
        action: args.id ? "update" : "create", id: args.id ? String(args.id) : undefined,
        body: String(args.body), revision: typeof args.revision === "number" ? args.revision : undefined, actor: "agent", runId: ctx.run?.runId,
      });
      return JSON.stringify({ id, message: "已记录主动记忆；这是 AI 记录，不代表用户确认事实。" });
    },
  },
];
