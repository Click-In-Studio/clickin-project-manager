import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { canUserAccessProduction } from "@/lib/db";
import { getAssetsByMountPoint, type MountType } from "@/lib/asset-db";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const ok = session.isAdmin || (await canUserAccessProduction(session.openId, id));
  if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const mountType = sp.get("type") as MountType | null;
  const mountId = sp.get("id");
  if (!mountType || !mountId)
    return Response.json({ error: "缺少 type 或 id 参数" }, { status: 400 });

  const mountAuxId = sp.has("auxId") ? sp.get("auxId") : undefined;
  const results = await getAssetsByMountPoint(id, mountType, mountId, mountAuxId);
  return Response.json({ results });
}
