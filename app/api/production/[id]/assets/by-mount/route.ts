import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { listNodesByMountPoint, type MountType } from "@/lib/node/mount";
import { filterVisibleAssets } from "@/lib/asset/perm";
import { listVisibleWikiIds } from "@/lib/wiki/perm";

// GET：某挂载点上的全部节点（#420 第二批：泛化到 asset+wiki 两 kind）。
// 权限过滤按 kind 走各自内容面：asset → filterVisibleAssets（能力票∧结构 ∨
// publication@view）；wiki → listVisibleWikiIds（含挂载让渡通道——能看到这个
// 宿主页的人通常经让渡可见挂着的文档，但门在判定不在页面）。

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const sp = req.nextUrl.searchParams;
  const mountType = sp.get("type") as MountType | null;
  const mountId = sp.get("id");
  if (!mountType || !mountId)
    return Response.json({ error: "缺少 type 或 id 参数" }, { status: 400 });

  const mountAuxId = sp.has("auxId") ? sp.get("auxId") : undefined;
  const entries = await listNodesByMountPoint(id, mountType, mountId, mountAuxId);

  const assetEntries = entries.filter(e => e.asset);
  const visibleAssets = await filterVisibleAssets(actor, id, assetEntries.map(e => e.asset!));
  const visibleAssetIds = new Set(visibleAssets.map(a => a.id));

  const wikiEntries = entries.filter(e => e.wiki);
  let visibleWikiIds = new Set<string>();
  let wikiWildcard = false;
  if (wikiEntries.length > 0) {
    const vis = await listVisibleWikiIds(actor, id);
    wikiWildcard = vis.wildcard;
    visibleWikiIds = vis.ids;
  }

  return Response.json({
    results: entries.filter(e =>
      e.asset ? visibleAssetIds.has(e.asset.id)
      : e.wiki ? (wikiWildcard || visibleWikiIds.has(e.wiki.id))
      : false),
  });
}
