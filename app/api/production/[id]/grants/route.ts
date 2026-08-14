import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { listGrantLedger, revokeGrantById, type GrantLedgerFilters } from "@/lib/grant-audit-db";

type Ctx = { params: Promise<{ id: string }> };

// 权限审计账本。治理域显式门（production 为 RESERVED_TYPE，通配不穿透）：
// 读流水=production/*/grants@view；强制撤销=production/*/grants@delete。
async function requireGate(req: NextRequest, productionId: string, verb: "view" | "delete") {
  const session = getSession(req.cookies);
  if (!session) return { deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  const { permCtx } = access;
  const ok = session.isAdmin || permCtx.isAdmin || permCtx.isOwner ||
    await hasGrant(permCtx.userId, productionId, "production", "*", "grants", verb) ||
    (verb === "view" && await hasGrant(permCtx.userId, productionId, "production", "*", "grants", "delete"));
  if (!ok) return { deny: Response.json({ error: "权限不足" }, { status: 403 }) };
  return { deny: null };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGate(req, id, "view");
  if (deny) return deny;

  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  const filters: GrantLedgerFilters = {
    userId: sp.get("user") || undefined,
    resourceType: sp.get("type") || undefined,
    grantSource: sp.get("source") || undefined,
    status: status === "active" || status === "revoked" || status === "expired" ? status : undefined,
    limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
    offset: sp.get("offset") ? Number(sp.get("offset")) : undefined,
  };
  const result = await listGrantLedger(id, filters);
  return Response.json(result);
}

/** POST — 强制撤销。Body: { grantId } */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGate(req, id, "delete");
  if (deny) return deny;

  const { grantId } = (await req.json()) as { grantId?: string };
  if (!grantId) return Response.json({ error: "缺少 grantId" }, { status: 400 });

  const ok = await revokeGrantById(id, grantId);
  if (!ok) return Response.json({ error: "授权不存在或已撤销" }, { status: 404 });
  return Response.json({ ok: true });
}
