/**
 * 审批流程模版：列表 + 创建（prA）。
 *
 * 门：空 OR 链 = 仅 owner / admin 旁路（v1 owner 门，设计文档 §8）。放开路径 =
 * 未来在 OR 链里加 grant tuple，不新铸权限键。读也收 owner：「流程设置」入口
 * 本身就是 owner 面，成员没有半个模版可看的理由（含硬编码示例在内的任何配置
 * 面数据都不该对申请人可见）。
 */
import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/api-guard";
import { createFlowTemplate, listFlowTemplates } from "@/lib/approval-flow-template-db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, []);
  if (deny) return deny;
  return Response.json({ templates: await listFlowTemplates(id) });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny, session } = await requireGrantGate(req, id, [], { blockArchived: true });
  if (deny) return deny;

  let body: { name?: unknown; description?: unknown; resourceScope?: unknown; nodes?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "body 不是 JSON" }, { status: 400 }); }

  const result = await createFlowTemplate(id, session!.userId, {
    name: typeof body.name === "string" ? body.name : "",
    description: typeof body.description === "string" ? body.description : undefined,
    resourceScope: typeof body.resourceScope === "string" ? body.resourceScope : undefined,
    nodes: body.nodes,
  });
  if (!result.ok) return Response.json({ error: "校验失败", errors: result.errors }, { status: 400 });
  return Response.json({ template: result.template }, { status: 201 });
}
