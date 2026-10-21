import { Type } from "typebox";
import type { ToolDefinition } from "./tools";
import { mutateMemoryEntry } from "@/lib/agent/memory/memory-db";
import {
  readMemoryGroups,
  readGroupPage,
  touchMemory,
} from "@/lib/agent/memory/memory-group-db";
import {
  resolveMemoryGroup,
  type MemoryResolution,
} from "@/lib/agent/memory/memory-resolve-db";
import { searchMemoryGroups } from "@/lib/agent/memory/memory-search-db";
import { maintainMemoryCache } from "@/lib/agent/memory/organize";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";

const scope = Type.Union([Type.Literal("general"), Type.Literal("project")]);
function production(
  ctx: { productionId: string | null },
  args: Record<string, unknown>,
): string | null {
  if (args.scope === "project" && !ctx.productionId)
    throw new Error("当前会话没有关联项目");
  return args.scope === "project" ? ctx.productionId : null;
}
const ids = Type.Array(Type.String(), { minItems: 1, maxItems: 50 });
const text = (value: unknown) => neutralizeInjectionTags(JSON.stringify(value));
const ownWrite = {
  readOnly: false,
  unattended: "deny" as const,
  reversibleNoConfirm: true as const,
};
export const MEMORY_DEFS: ToolDefinition[] = [
  {
    mcpName: "my.memory_read",
    readOnly: true,
    description:
      "读取个人通用/当前项目记忆的组概览，命中任一条目共同返回整组brief/时间/疑似关系，超限组返回防偏摘要。需要正文时传groupId、groupRevision和offset进入组核对分页（每页5条，返回nextOffset），partial不能作为完整依据。无关组不必核对。",
    parameters: Type.Object({
      scope,
      ids: Type.Optional(ids),
      groupId: Type.Optional(Type.String()),
      groupRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    execute: async (ctx, args) => {
      const pid = production(ctx, args);
      if (args.groupId) {
        const page = await readGroupPage(
          ctx.userId,
          pid,
          String(args.groupId),
          Number(args.groupRevision),
          Number(args.offset ?? 0),
        );
        return text({
          ...page,
          partial: page.nextOffset !== null || Number(args.offset ?? 0) > 0,
          note: "正在核对整组。先核对相关各方，再resolve或问用户；不能偏取单方作为确定事实。",
        });
      }
      return text(
        await readMemoryGroups(
          ctx.userId,
          pid,
          args.ids as string[] | undefined,
        ),
      );
    },
  },
  {
    mcpName: "my.memory_write",
    ...ownWrite,
    description:
      "主动维护用户明确确认的个人协作信息，免逐条确认。用户自然明确交代的事实/要求或明确采纳的方案可按需记录；助手提议和模型推断不算确认。正文和brief不得添加信息，必须补充时先问用户，得到明确答复再写入。项目内容scope=project。create写body和独立完整brief；update/delete需已有id/revision，不能覆盖用户编辑。疑似重复/冲突组用memory_resolve维护，不制造矛盾副本。删除只移出有效记忆，用户可恢复。",
    parameters: Type.Object({
      scope,
      action: Type.Optional(
        Type.Union([
          Type.Literal("create"),
          Type.Literal("update"),
          Type.Literal("delete"),
        ]),
      ),
      body: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
      brief: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      id: Type.Optional(Type.String()),
      revision: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    mutates: (args) => ({
      scope: "memory",
      action:
        args.action === "delete" ? "deleted" : args.id ? "updated" : "created",
      ids: args.id ? [String(args.id)] : undefined,
    }),
    execute: async (ctx, args) => {
      const pid = production(ctx, args);
      const action = (args.action ?? (args.id ? "update" : "create")) as
        | "create"
        | "update"
        | "delete";
      if (action !== "delete" && typeof args.brief !== "string")
        throw new Error("新记忆需要独立brief");
      const id = await mutateMemoryEntry(ctx.userId, pid, {
        action,
        id: args.id as string | undefined,
        revision: args.revision as number | undefined,
        body: args.body as string | undefined,
        brief: args.brief as string | undefined,
        actor: "agent",
        runId: ctx.run?.runId,
      });
      let note = "";
      try {
        await maintainMemoryCache(ctx.userId, pid);
      } catch {
        note = "缓存整理暂未完成；记忆已保存，未把失败当作已整理。";
      }
      return text({
        id,
        message:
          "个人记忆已维护；保存成功不代替用户确认，写入内容须忠于用户明确表达或采纳的信息。",
        note,
      });
    },
  },
  {
    mcpName: "my.memory_touch",
    ...ownWrite,
    description:
      "实际采用记忆信息时必须先批量touch对应条目，再给最终答复，整组刷新访问并回到中期缓存。brief足够时直接touch，无须读取正文；只答一个名称也要记录使用。注入、读取或搜索命中本身不算使用，已排除或未采用的条目不要touch。不修改正文及事实时间。",
    parameters: Type.Object({ scope, ids }),
    mutates: (args) => ({
      scope: "memory",
      action: "updated",
      ids: args.ids as string[],
    }),
    execute: async (ctx, args) => {
      await touchMemory(
        ctx.userId,
        production(ctx, args),
        args.ids as string[],
        ctx.run?.runId,
      );
      try {
        await maintainMemoryCache(ctx.userId, production(ctx, args));
      } catch {
        return "已touch；缓存整理待重试，正文和事实时间未改变。";
      }
      return "已touch对应记忆组；正文和事实时间未改变。";
    },
  },
  {
    mcpName: "my.memory_find",
    readOnly: true,
    description:
      "搜索有效长期记忆的brief和正文；个人通用或当前项目范围。任一命中共同返回待核对组，超限返回防偏摘要。不会把原始历史问答当作当前事实，也不因搜索自动touch。",
    parameters: Type.Object({
      scope,
      query: Type.String({ minLength: 1, maxLength: 500 }),
    }),
    execute: async (ctx, args) =>
      text(
        await searchMemoryGroups(
          ctx.userId,
          production(ctx, args),
          String(args.query),
        ),
      ),
  },
  {
    mcpName: "my.memory_resolve",
    ...ownWrite,
    description:
      "主模型依据用户明确确认的信息原子解决待核对组。传概览的groupId/revision、已核对的relationIds和changes。重复需保真合并（修改保留条目，remove其他条目），不是简单替代；正文和brief不得添加未确认信息。解决冲突或补充内容所需信息不足时先问用户，得到明确答复再写入，期间保持未解决。relationIds也可仅解除误判关系。所有修改须条目revision，用户编辑受保护。",
    parameters: Type.Object({
      scope,
      groupId: Type.String(),
      revision: Type.Integer({ minimum: 0 }),
      reason: Type.String({ minLength: 1, maxLength: 1000 }),
      relationIds: Type.Array(Type.String(), { maxItems: 100 }),
      changes: Type.Array(
        Type.Object({
          id: Type.String(),
          revision: Type.Integer({ minimum: 0 }),
          body: Type.Optional(Type.String({ maxLength: 1000 })),
          brief: Type.Optional(Type.String({ maxLength: 300 })),
          remove: Type.Optional(Type.Boolean()),
        }),
        { maxItems: 50 },
      ),
    }),
    mutates: (args) => ({
      scope: "memory",
      action: "updated",
      ids: ((args.changes ?? []) as Array<{ id: string }>).map((e) => e.id),
    }),
    execute: async (ctx, args) => {
      await resolveMemoryGroup(
        ctx.userId,
        production(ctx, args),
        args as unknown as MemoryResolution,
        ctx.run?.runId,
      );
      return "已按核对结果维护记忆并重算连通组。";
    },
  },
];
