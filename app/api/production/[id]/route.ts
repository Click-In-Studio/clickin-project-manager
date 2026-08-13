import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { loadProduction, getProductionPermissionContext, getActiveVersionId, listVersions, updateProductionName, updateProductionMeta, updateProductionType, getVersion, deleteProduction } from "@/lib/db";
import { getSession } from "@/lib/session";
import { hasPermission } from "@/lib/permissions";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]">) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;

  const _access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!_access) return Response.json({ error: "无权访问该剧本" }, { status: 403 });

  try {
    const requestedVersionId = req.nextUrl.searchParams.get("v");
    let versionId = requestedVersionId ?? await getActiveVersionId(id);
    if (!versionId) {
      return Response.json({ error: "剧本不存在或无版本" }, { status: 404 });
    }
    let version = await getVersion(versionId);
    // Requested version missing or belongs to another production — fall back to active version
    if (requestedVersionId && (!version || version.productionId !== id)) {
      const fallbackId = await getActiveVersionId(id);
      versionId = fallbackId ?? versionId;
      version = fallbackId ? await getVersion(fallbackId) : null;
    }
    if (!version || version.productionId !== id) {
      return Response.json({ error: "版本不存在" }, { status: 404 });
    }

    const [result, versions] = await Promise.all([
      loadProduction(id, versionId),
      listVersions(id),
    ]);

    if (!result) {
      return Response.json({ error: "剧本不存在" }, { status: 404 });
    }

    return Response.json({ state: result.state, versionId, versions });
  } catch (err) {
    console.error("[production] load error:", err);
    return Response.json({ error: "加载失败" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/production/[id]">) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const body = await req.json() as {
    name?: string;
    description?: string;
    avatarUrl?: string | null;
    language?: string | null;
    type?: string | null;
    typeLabel?: string | null;
  };

  const jobs: Promise<void>[] = [];

  if (body.name !== undefined) {
    if (!(access.permCtx.isOwner || (access.permCtx.isAdmin && access.permCtx.memberPermissions === null) || await hasGrant(access.permCtx.userId, id, "production", "*", "meta/name", "edit"))) {
      return Response.json({ error: "无权修改名称" }, { status: 403 });
    }
    if (!body.name.trim()) return Response.json({ error: "名称不能为空" }, { status: 400 });
    jobs.push(updateProductionName(id, body.name.trim()));
  }

  if ("description" in body) {
    if (!(access.permCtx.isOwner || (access.permCtx.isAdmin && access.permCtx.memberPermissions === null) || await hasGrant(access.permCtx.userId, id, "production", "*", "meta/description", "edit"))) {
      return Response.json({ error: "无权修改项目简介" }, { status: 403 });
    }
    jobs.push(updateProductionMeta(id, { description: body.description }));
  }

  if ("avatarUrl" in body) {
    if (!(access.permCtx.isOwner || (access.permCtx.isAdmin && access.permCtx.memberPermissions === null) || await hasGrant(access.permCtx.userId, id, "production", "*", "meta/avatar", "edit"))) {
      return Response.json({ error: "无权修改项目头像" }, { status: 403 });
    }
    jobs.push(updateProductionMeta(id, { avatarUrl: body.avatarUrl }));
  }

  if ("language" in body) {
    if (!(access.permCtx.isOwner || (access.permCtx.isAdmin && access.permCtx.memberPermissions === null) || await hasGrant(access.permCtx.userId, id, "production", "*", "meta/language", "edit"))) {
      return Response.json({ error: "无权修改项目语言" }, { status: 403 });
    }
    jobs.push(updateProductionMeta(id, { language: body.language }));
  }

  if ("type" in body || "typeLabel" in body) {
    if (!(access.permCtx.isOwner || (access.permCtx.isAdmin && access.permCtx.memberPermissions === null) || await hasGrant(access.permCtx.userId, id, "production", "*", "meta/type", "edit"))) {
      return Response.json({ error: "无权修改项目类型" }, { status: 403 });
    }
    jobs.push(updateProductionType(id, body.type ?? null, body.typeLabel ?? null));
  }

  if (!jobs.length) return Response.json({ error: "无有效字段" }, { status: 400 });

  await Promise.all(jobs);
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: RouteContext<"/api/production/[id]">) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !(access.permCtx.isAdmin || access.permCtx.isOwner)) {
    return Response.json({ error: "无权限，仅项目所有者可删除" }, { status: 403 });
  }

  await deleteProduction(id);
  return Response.json({ ok: true });
}
