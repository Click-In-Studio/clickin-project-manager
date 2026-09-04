import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/api-guard";
import { listPrivateAssets, setAssetPublic, revokeAssetGrant } from "@/lib/asset/review-db";

type Ctx = { params: Promise<{ id: string }> };

// 数字资产审查（越隐私查看/处置）。治理域显式门（production 为 RESERVED_TYPE）：
// 读=production/*/asset_review@view（edit 覆盖读）；处置=production/*/asset_review@edit。

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, [
    ["production", "asset_review", "view"],
    ["production", "asset_review", "edit"],
  ]);
  if (deny) return deny;
  return Response.json({ assets: await listPrivateAssets(id) });
}

/** POST — 审查处置。Body:
 *  { action: "set_public", assetId } 或 { action: "revoke_grant", grantId }（仅 asset 类 grant） */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, [["production", "asset_review", "edit"]], { blockArchived: true });
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
