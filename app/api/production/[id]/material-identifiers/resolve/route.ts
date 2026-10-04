import type { NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { getMaterial } from "@/lib/ops/material-db";
import { canManageMaterialIdentifiers } from "@/lib/ops/material-perm";
import { resolveMaterialIdentifierByCode, resolveMaterialIdentifierByToken } from "@/lib/ops/material-identifier-db";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, false, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (typeof body.code !== "string" || !body.code.trim()
      || (body.action !== undefined && body.action !== "view" && body.action !== "manage"))
    return Response.json({ error: "码解析参数无效" }, { status: 400 });
  const tokenMatch = body.code.trim().match(/\/api\/material-identifiers\/scan\/([A-Za-z0-9_-]+)(?:[?#].*)?$/);
  const result = tokenMatch
    ? await resolveMaterialIdentifierByToken(tokenMatch[1])
    : await resolveMaterialIdentifierByCode(productionId, body.code);
  if (result !== "not_found" && result !== "conflict"
      && result.identifier.productionId !== productionId)
    return Response.json({ status: "not_found", error: "未找到该标识" }, { status: 404 });
  if (result === "not_found")
    return Response.json({ status: "not_found", error: "未找到该标识" }, { status: 404 });
  if (result === "conflict")
    return Response.json({ status: "conflict", error: "该标识存在冲突" }, { status: 409 });
  const actor = toActor(session, access.permCtx);
  const material = await getMaterial(result.identifier.materialId, productionId);
  if (!material) return Response.json({ status: "not_found", error: "物料不存在" }, { status: 404 });
  const permitted = body.action === "manage"
    ? !access.isArchived && await canManageMaterialIdentifiers(actor, productionId, material.id)
    : await hasEffectiveGrant(actor, productionId, "material", "*", "*", "view");
  if (!permitted)
    return Response.json({ status: "forbidden", error: "无权执行本次动作" }, { status: 403 });
  return Response.json(result);
}
