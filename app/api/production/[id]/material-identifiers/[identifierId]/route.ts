import type { NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { toActor } from "@/lib/perm/grant-check";
import { getMaterial } from "@/lib/ops/material-db";
import { canWriteMaterial } from "@/lib/ops/material-perm";
import {
  getMaterialIdentifier,
  MaterialIdentifierError,
  replaceMaterialStockIdentifier,
  retireMaterialIdentifier,
} from "@/lib/ops/material-identifier-db";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string; identifierId: string }> };

function identifierErrorResponse(error: MaterialIdentifierError) {
  const status = error.reason === "bad_code" ? 400
    : error.reason === "not_found" ? 404 : 409;
  return Response.json({ error: error.message, reason: error.reason }, { status });
}

async function writableContext(req: NextRequest, ctx: Ctx) {
  const { id: productionId, identifierId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return { response: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, false, productionId);
  if (!access) return { response: Response.json({ error: "无权访问" }, { status: 403 }) };
  if (access.isArchived)
    return { response: Response.json({ error: "已归档的项目不可修改" }, { status: 403 }) };
  const identifier = await getMaterialIdentifier(productionId, identifierId);
  if (!identifier)
    return { response: Response.json({ error: "标识不存在" }, { status: 404 }) };
  const material = await getMaterial(identifier.materialId, productionId);
  if (!material) return { response: Response.json({ error: "物料不存在" }, { status: 404 }) };
  if (!await canWriteMaterial(toActor(session, access.permCtx), productionId, material, "edit"))
    return { response: Response.json({ error: "权限不足" }, { status: 403 }) };
  return { productionId, identifierId, session };
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const current = await writableContext(req, ctx);
  if ("response" in current) return current.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  if (typeof parsed.value.reason !== "string" || !parsed.value.reason.trim())
    return Response.json({ error: "必须填写失效原因" }, { status: 400 });
  try {
    return Response.json({ identifier: await retireMaterialIdentifier({
      productionId: current.productionId,
      identifierId: current.identifierId,
      retiredBy: current.session.userId,
      reason: parsed.value.reason,
    }) });
  } catch (error) {
    if (error instanceof MaterialIdentifierError) return identifierErrorResponse(error);
    throw error;
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const current = await writableContext(req, ctx);
  if ("response" in current) return current.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  if (typeof parsed.value.reason !== "string" || !parsed.value.reason.trim())
    return Response.json({ error: "必须填写换码原因" }, { status: 400 });
  try {
    return Response.json(await replaceMaterialStockIdentifier({
      productionId: current.productionId,
      identifierId: current.identifierId,
      replacedBy: current.session.userId,
      reason: parsed.value.reason,
    }));
  } catch (error) {
    if (error instanceof MaterialIdentifierError) return identifierErrorResponse(error);
    throw error;
  }
}
