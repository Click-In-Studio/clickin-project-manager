import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { listPrivateAssets, setAssetPublic, revokeAssetGrant } from "@/lib/asset-review-db";

type Ctx = { params: Promise<{ id: string }> };

// 数字资产审查（越隐私查看/处置）。治理域显式门（production 为 RESERVED_TYPE）：
// 读=production/*/asset_review@view；处置=production/*/asset_review@edit。
async function requireGate(req: NextRequest, productionId: string, verb: "view" | "edit") {
  const session = getSession(req.cookies);
  if (!session) return { deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  const { permCtx } = access;
  const ok = session.isAdmin || permCtx.isAdmin || permCtx.isOwner ||
    await hasGrant(permCtx.userId, productionId, "production", "*", "asset_review", verb) ||
    (verb === "view" && await hasGrant(permCtx.userId, productionId, "production", "*", "asset_review", "edit"));
  if (!ok) return { deny: Response.json({ error: "权限不足" }, { status: 403 }) };
  if (verb === "edit" && access.isArchived) {
    return { deny: Response.json({ error: "已归档的项目不可修改" }, { status: 403 }) };
  }
  return { deny: null };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGate(req, id, "view");
  if (deny) return deny;
  return Response.json({ assets: await listPrivateAssets(id) });
}

/** POST — 审查处置。Body:
 *  { action: "set_public", assetId } 或 { action: "revoke_grant", grantId }（仅 asset 类 grant） */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGate(req, id, "edit");
  if (deny) return deny;

  const body = (await req.json()) as { action?: string; assetId?: string; grantId?: string };

  if (body.action === "set_public") {
    if (!body.assetId) return Response.json({ error: "缺少 assetId" }, { status: 400 });
    const ok = await setAssetPublic(id, body.assetId, true);
    if (!ok) return Response.json({ error: "资产不存在" }, { status: 404 });
    return Response.json({ ok: true });
  }

  if (body.action === "revoke_grant") {
    if (!body.grantId) return Response.json({ error: "缺少 grantId" }, { status: 400 });
    // 本门只允许处置 asset 类授权（越界撤销走权限审计的 grants@delete 门）
    const result = await revokeAssetGrant(id, body.grantId);
    if (result === "not_found") return Response.json({ error: "授权不存在或已撤销" }, { status: 404 });
    if (result === "wrong_type") return Response.json({ error: "该门仅可撤销资产类授权" }, { status: 403 });
    return Response.json({ ok: true });
  }

  return Response.json({ error: "未知 action" }, { status: 400 });
}
