import type { NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { getMaterial, listMaterialStockLots } from "@/lib/ops/material-db";
import { canWriteMaterial } from "@/lib/ops/material-perm";
import {
  createExternalMaterialIdentifier,
  listMaterialIdentifiers,
  MaterialIdentifierError,
} from "@/lib/ops/material-identifier-db";
import { isMaterialExternalIdentifierType } from "@/lib/ops/material-identifier-types";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string; materialId: string; lotId: string }> };

async function context(req: NextRequest, ctx: Ctx) {
  const { id: productionId, materialId, lotId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return { response: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, false, productionId);
  if (!access) return { response: Response.json({ error: "无权访问" }, { status: 403 }) };
  const material = await getMaterial(materialId, productionId);
  if (!material) return { response: Response.json({ error: "物料不存在" }, { status: 404 }) };
  const lot = (await listMaterialStockLots(materialId, productionId)).find(item => item.id === lotId);
  if (!lot) return { response: Response.json({ error: "物料实物或批次不存在" }, { status: 404 }) };
  return { productionId, materialId, lotId, session, access, material };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const current = await context(req, ctx);
  if ("response" in current) return current.response;
  const actor = toActor(current.session, current.access.permCtx);
  if (!await hasEffectiveGrant(actor, current.productionId, "material", "*", "*", "view"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  return Response.json({
    identifiers: await listMaterialIdentifiers(
      current.productionId, current.materialId, current.lotId,
    ),
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const current = await context(req, ctx);
  if ("response" in current) return current.response;
  if (current.access.isArchived)
    return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(current.session, current.access.permCtx);
  if (!await canWriteMaterial(actor, current.productionId, current.material, "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (!isMaterialExternalIdentifierType(body.type) || typeof body.value !== "string"
      || (body.label !== undefined && typeof body.label !== "string"))
    return Response.json({ error: "外部标识参数无效" }, { status: 400 });
  try {
    const identifier = await createExternalMaterialIdentifier({
      productionId: current.productionId,
      materialId: current.materialId,
      lotId: current.lotId,
      externalType: body.type,
      externalLabel: body.label as string | undefined,
      value: body.value,
      createdBy: current.session.userId,
    });
    return Response.json({ identifier }, { status: 201 });
  } catch (error) {
    if (error instanceof MaterialIdentifierError)
      return Response.json({ error: error.message, reason: error.reason }, { status: 409 });
    throw error;
  }
}
