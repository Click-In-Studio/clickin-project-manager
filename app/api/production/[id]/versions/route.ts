import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  canUserAccessProduction, listVersions, createVersion, getActiveVersionId,
} from "@/lib/db";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const ok = session.isAdmin || (await canUserAccessProduction(session.openId, id));
  if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });

  const versions = await listVersions(id);
  return Response.json({ versions });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  if (!session.isAdmin) {
    const ok = await canUserAccessProduction(session.openId, id);
    if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = (await req.json()) as { fromVersionId?: string; name?: string };
  const fromVersionId = body.fromVersionId ?? await getActiveVersionId(id);
  if (!fromVersionId) return Response.json({ error: "无可用版本" }, { status: 400 });
  const name = body.name ?? `新版本 ${new Date().toLocaleDateString("zh-CN")}`;

  const version = await createVersion(id, fromVersionId, name);
  return Response.json({ version }, { status: 201 });
}
