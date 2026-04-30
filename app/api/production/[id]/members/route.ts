import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  listProductionMembers,
  addProductionMember,
  removeProductionMember,
  isProductionArchived,
} from "@/lib/db";

function requireAdmin(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });
  return session;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const members = await listProductionMembers(id);
  return Response.json({ members });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (await isProductionArchived(id)) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const { openId } = (await req.json()) as { openId?: string };
  if (!openId) return Response.json({ error: "缺少 openId" }, { status: 400 });
  await addProductionMember(id, openId);
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (await isProductionArchived(id)) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const { openId } = (await req.json()) as { openId?: string };
  if (!openId) return Response.json({ error: "缺少 openId" }, { status: 400 });
  await removeProductionMember(id, openId);
  return Response.json({ ok: true });
}
