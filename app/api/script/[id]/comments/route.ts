import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listProductionComments, createComment } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

async function guard(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (!hasPermission("script:comment", session.isAdmin, memberRoles, overrides)) {
    return { session, deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  }
  return { session, deny: null };
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/script/[id]/comments">) {
  const { id } = await ctx.params;
  const { deny } = await guard(req, id);
  if (deny) return deny;
  const comments = await listProductionComments(id);
  return Response.json({ comments });
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/script/[id]/comments">) {
  const { id } = await ctx.params;
  const { session, deny } = await guard(req, id);
  if (!session || deny) return deny!;
  const { blockId, content } = (await req.json()) as { blockId?: string; content?: string };
  if (!blockId || !content?.trim()) return Response.json({ error: "参数错误" }, { status: 400 });
  const comment = await createComment(id, blockId, session.openId, session.name, content.trim());
  return Response.json({ comment }, { status: 201 });
}
