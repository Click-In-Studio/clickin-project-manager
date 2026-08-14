import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { parseNodeKey } from "@/lib/grant-template";
import { listGovernanceGrants, createDirectGrant, revokeGrantById } from "@/lib/grant-audit-db";

type Ctx = { params: Promise<{ id: string }> };

// 治理域授权（production/producer 域 grant 行直发/收回）——ROOT OPERATION。
async function requireRoot(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { session, deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  if (!(session.isAdmin || access.permCtx.isAdmin || access.permCtx.isOwner)) {
    return { session, deny: Response.json({ error: "治理域授权仅限所有者" }, { status: 403 }) };
  }
  return { session, deny: null };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireRoot(req, id);
  if (deny) return deny;
  return Response.json({ grants: await listGovernanceGrants(id) });
}

/** POST — 直发。Body: { userId, key }（key 限 production/producer 域节点串） */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { session, deny } = await requireRoot(req, id);
  if (deny) return deny;

  const { userId, key } = (await req.json()) as { userId?: string; key?: string };
  if (!userId || !key) return Response.json({ error: "userId 和 key 为必填" }, { status: 400 });
  const parsed = parseNodeKey(key);
  if (!parsed || (parsed.resourceType !== "production" && parsed.resourceType !== "producer")) {
    return Response.json({ error: "仅限 production / producer 域节点串" }, { status: 400 });
  }
  const grantId = await createDirectGrant(id, userId, {
    resourceType: parsed.resourceType,
    resourceId: parsed.resourceId,
    resourceSub: parsed.resourceSub,
    verb: parsed.verb,
  }, session!.userId);
  return Response.json({ ok: true, grantId });
}

/** DELETE — 收回。Body: { grantId } */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireRoot(req, id);
  if (deny) return deny;

  const { grantId } = (await req.json()) as { grantId?: string };
  if (!grantId) return Response.json({ error: "缺少 grantId" }, { status: 400 });
  const ok = await revokeGrantById(id, grantId);
  if (!ok) return Response.json({ error: "授权不存在或已撤销" }, { status: 404 });
  return Response.json({ ok: true });
}
