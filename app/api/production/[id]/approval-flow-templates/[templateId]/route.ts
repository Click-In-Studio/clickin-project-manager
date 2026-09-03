/**
 * 审批流程模版：单条读 / 改 / 删（prA）。门与列表接口同源（owner 门，空 OR 链）。
 *
 * PATCH 的 status 只接受 "draft"（回撤发布）；升 published 走 publish 子接口。
 * DELETE 仅草稿：published 必须先回草稿，挡「误删使用中配置」。
 */
import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/api-guard";
import {
  deleteFlowTemplate,
  getFlowTemplate,
  updateFlowTemplate,
} from "@/lib/approval-flow-template-db";

type Ctx = { params: Promise<{ id: string; templateId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id, templateId } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, []);
  if (deny) return deny;
  const template = await getFlowTemplate(id, templateId);
  if (!template) return Response.json({ error: "模版不存在" }, { status: 404 });
  return Response.json({ template });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id, templateId } = await ctx.params;
  const { deny, session } = await requireGrantGate(req, id, [], { blockArchived: true });
  if (deny) return deny;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ error: "body 不是 JSON" }, { status: 400 }); }

  const result = await updateFlowTemplate(id, templateId, session!.userId, {
    name: typeof body.name === "string" ? body.name : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    resourceScope: typeof body.resourceScope === "string" ? body.resourceScope : undefined,
    nodes: "nodes" in body ? body.nodes : undefined,
    status: typeof body.status === "string" ? body.status : undefined,
  });
  if (!result.ok) {
    if (result.reason === "not_found") return Response.json({ error: "模版不存在" }, { status: 404 });
    return Response.json({ error: "校验失败", errors: result.errors }, { status: 400 });
  }
  return Response.json({ template: result.template });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id, templateId } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, [], { blockArchived: true });
  if (deny) return deny;

  const result = await deleteFlowTemplate(id, templateId);
  if (!result.ok) {
    if (result.reason === "not_found") return Response.json({ error: "模版不存在" }, { status: 404 });
    return Response.json({ error: "使用中的模版不可删除，请先转回草稿" }, { status: 409 });
  }
  return Response.json({ ok: true });
}
