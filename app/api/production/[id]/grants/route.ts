import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/api-guard";
import { listGrantLedger, revokeGrantById, type GrantLedgerFilters } from "@/lib/grant-audit-db";

type Ctx = { params: Promise<{ id: string }> };

// 权限审计账本。治理域显式门（production 为 RESERVED_TYPE，通配不穿透）：
// 读流水=production/*/grants@view（delete 覆盖读）；强制撤销=production/*/grants@delete。

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, [
    ["production", "grants", "view"],
    ["production", "grants", "delete"],
  ]);
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
  const { deny } = await requireGrantGate(req, id, [["production", "grants", "delete"]]);
  if (deny) return deny;

  const { grantId } = (await req.json()) as { grantId?: string };
  if (!grantId) return Response.json({ error: "缺少 grantId" }, { status: 400 });

  const ok = await revokeGrantById(id, grantId);
  if (!ok) return Response.json({ error: "授权不存在或已撤销" }, { status: 404 });
  return Response.json({ ok: true });
}
