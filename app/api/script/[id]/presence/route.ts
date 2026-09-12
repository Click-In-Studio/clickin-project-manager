import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/perm/grant-check";
import { hasActiveSSEClient, updatePresence } from "@/lib/server-cache";
import { getActiveVersionId, getVersion, getProductionPermissionContext } from "@/lib/db";
import { getSession } from "@/lib/account/session";

type PresenceBody = {
  clientId: string;
  userName: string;
  blockId: string | null;
  versionId?: string;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { clientId, userName, blockId, versionId: bodyVersionId } = (await req.json()) as PresenceBody;
  if (!clientId || !userName) return Response.json({ error: "missing fields" }, { status: 400 });

  // 快路径（#460）：同一 clientId 在该 (production, version) 上已有活跃 SSE 连接。
  // stream/route.ts 建连时已过与下面逐字相同的权限门和版本归属校验，且连接断开
  // 即失效——心跳不再重跑 7 条 DB 查询，只写内存 presence Map。
  //
  // 撤销时效边界：权限撤销后快路径会一直放行到流断开为止。这是有意接受的——
  // 撤销本就不断开已建立的 SSE 流（撤销者照收广播，读面缺口先于本 PR 存在，
  // 见 #469），心跳逐拍重查只守住了写面的 200ms 窗口、守不住读面；真正的修法
  // 是撤销写点主动断流（#469），断流后快路径自然失效。
  const explicitVersionId = bodyVersionId ?? req.nextUrl.searchParams.get("v");
  if (explicitVersionId !== null && hasActiveSSEClient(id, explicitVersionId, clientId)) {
    updatePresence(id, explicitVersionId, clientId, userName, blockId);
    return Response.json({ ok: true });
  }

  // 慢路径：无活跃 SSE（首拍抢跑、断线重连间隙、未带版本号）——走全套权限门。
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !(access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(access.permCtx.userId, id, "script", "*", "blocks", "view")))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const versionId = explicitVersionId ?? await getActiveVersionId(id) ?? '';
  if (versionId) {
    const version = await getVersion(versionId);
    if (!version || version.productionId !== id) {
      return Response.json({ error: "版本不存在" }, { status: 404 });
    }
  }
  updatePresence(id, versionId, clientId, userName, blockId);
  return Response.json({ ok: true });
}
