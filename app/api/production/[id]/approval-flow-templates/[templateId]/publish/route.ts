/**
 * 审批流程模版：发布（prA）。事务内先降旧再升新——「切换使用中的流程」，
 * 单一使用中由部分唯一索引兜底。门与其余模版接口同源（owner 门，空 OR 链）。
 *
 * 注意：引擎（prB）落地前 published 仅是声明标记，不驱动任何申请的流转；
 * 前端发布按钮的提示文案要如实说明（prC 接线时处理）。
 */
import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/api-guard";
import { publishFlowTemplate } from "@/lib/approval-flow-template-db";

type Ctx = { params: Promise<{ id: string; templateId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, templateId } = await ctx.params;
  const { deny, session } = await requireGrantGate(req, id, [], { blockArchived: true });
  if (deny) return deny;

  const result = await publishFlowTemplate(id, templateId, session!.userId);
  if (!result.ok) return Response.json({ error: "模版不存在" }, { status: 404 });
  return Response.json({ template: result.template });
}
