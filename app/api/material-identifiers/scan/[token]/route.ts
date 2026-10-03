import type { NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { getMaterial } from "@/lib/ops/material-db";
import { canWriteMaterial } from "@/lib/ops/material-perm";
import { resolveMaterialIdentifierByToken } from "@/lib/ops/material-identifier-db";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { token } = await ctx.params;
  const result = await resolveMaterialIdentifierByToken(token);
  if (result === "not_found")
    return Response.json({ status: "not_found", error: "未找到该标识" }, { status: 404 });
  if (result === "conflict")
    return Response.json({ status: "conflict", error: "该标识存在冲突" }, { status: 409 });
  const access = await getProductionPermissionContext(
    session.userId, false, result.identifier.productionId,
  );
  if (!access)
    return Response.json({ status: "forbidden", error: "无权访问对应项目" }, { status: 403 });
  const actor = toActor(session, access.permCtx);
  const material = await getMaterial(result.identifier.materialId, result.identifier.productionId);
  if (!material) return Response.json({ status: "not_found", error: "物料不存在" }, { status: 404 });
  const action = req.nextUrl.searchParams.get("action") ?? "view";
  if (action !== "view" && action !== "manage")
    return Response.json({ error: "扫码动作无效" }, { status: 400 });
  const permitted = action === "manage"
    ? !access.isArchived
      && await canWriteMaterial(actor, result.identifier.productionId, material, "edit")
    : await hasEffectiveGrant(
        actor, result.identifier.productionId, "material", "*", "*", "view",
      );
  if (!permitted)
    return Response.json({ status: "forbidden", error: "无权执行本次动作" }, { status: 403 });
  return Response.json(result);
}
