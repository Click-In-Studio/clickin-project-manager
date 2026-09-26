import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getAsset } from "@/lib/asset/db";
import { canCreateShareToken, canManageShareLinks } from "@/lib/asset/perm";
import { createAssetShareLink, listAssetShareLinks } from "@/lib/asset/share-link-db";

type Ctx = { params: Promise<{ id: string; assetId: string }> };
type ResolvedContext =
  | { deny: Response }
  | {
      id: string;
      assetId: string;
      session: NonNullable<ReturnType<typeof getSession>>;
      access: NonNullable<Awaited<ReturnType<typeof getProductionPermissionContext>>>;
      asset: NonNullable<Awaited<ReturnType<typeof getAsset>>>;
    };

function jsonLink(link: Awaited<ReturnType<typeof createAssetShareLink>>) {
  const status = link.revokedAt ? "revoked"
    : link.expiresAt.getTime() <= Date.now() ? "expired"
      : link.oneTime && link.redeemedAt ? "redeemed"
        : "active";
  return {
    id: link.id,
    token: link.token,
    allowDownload: link.allowDownload,
    oneTime: link.oneTime,
    note: link.note,
    expiresAt: link.expiresAt.toISOString(),
    createdAt: link.createdAt.toISOString(),
    revokedAt: link.revokedAt?.toISOString() ?? null,
    redeemedAt: link.redeemedAt?.toISOString() ?? null,
    status,
  };
}

async function context(req: NextRequest, ctx: Ctx): Promise<ResolvedContext> {
  const { id, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return { deny: Response.json({ error: "未登录" }, { status: 401 }) };

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) {
    return { deny: Response.json({ error: "资产不存在" }, { status: 404 }) };
  }
  return { id, assetId, session, access, asset };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const resolved = await context(req, ctx);
  if ("deny" in resolved) return resolved.deny;
  const cap = await canManageShareLinks(resolved.access.permCtx, resolved.id, resolved.asset);
  if (!cap.allowed) return Response.json({ error: "权限不足" }, { status: 403 });

  const links = await listAssetShareLinks(resolved.id, resolved.assetId);
  return Response.json({ links: links.map(jsonLink) });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const resolved = await context(req, ctx);
  if ("deny" in resolved) return resolved.deny;
  if (resolved.access.isArchived) return Response.json({ error: "项目已归档" }, { status: 403 });

  const shareCap = await canCreateShareToken(resolved.access.permCtx, resolved.id, resolved.asset);
  if (!shareCap.allowed) return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as {
    expiresInDays?: number;
    allowDownload?: boolean;
    oneTime?: boolean;
    note?: string | null;
  };
  const expiresInDays = Math.max(1, Math.min(365, body.expiresInDays ?? 30));
  const allowDownload = (body.allowDownload ?? false) && shareCap.downloadable;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 120) || null : null;

  const link = await createAssetShareLink({
    assetId: resolved.assetId,
    productionId: resolved.id,
    createdBy: resolved.session.userId,
    expiresInDays,
    allowDownload,
    oneTime: body.oneTime === true,
    note,
  });
  return Response.json({ link: jsonLink(link) }, { status: 201 });
}
