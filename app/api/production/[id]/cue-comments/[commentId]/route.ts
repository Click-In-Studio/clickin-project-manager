import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { updateComment, deleteComment, getProductionMemberContext } from "@/lib/db";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; commentId: string }> },
) {
  const { id: productionId, commentId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const { body } = (await req.json()) as { body?: string };
  if (!body?.trim()) return Response.json({ error: "内容不能为空" }, { status: 400 });
  const comment = await updateComment(commentId, session.openId, body.trim());
  if (!comment) return Response.json({ error: "评论不存在或无权修改" }, { status: 403 });
  return Response.json({ comment });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; commentId: string }> },
) {
  const { id: productionId, commentId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const ok = await deleteComment(commentId, session.openId, session.isAdmin);
  if (!ok) return Response.json({ error: "评论不存在或无权删除" }, { status: 403 });
  return Response.json({ ok: true });
}
