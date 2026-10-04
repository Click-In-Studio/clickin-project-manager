import type { NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { toActor } from "@/lib/perm/grant-check";
import { getMaterial, listMaterialStockLots, MaterialError } from "@/lib/ops/material-db";
import { canManageMaterialSources } from "@/lib/ops/material-perm";
import { recordMaterialSourceException } from "@/lib/ops/material-source-db";
import { isMaterialSourceExceptionKind } from "@/lib/ops/material-types";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string; materialId: string; lotId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, materialId, lotId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, false, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const material = await getMaterial(materialId, productionId);
  if (!material) return Response.json({ error: "物料不存在" }, { status: 404 });
  if (!await canManageMaterialSources(toActor(session, access.permCtx), productionId, material))
    return Response.json({ error: "权限不足" }, { status: 403 });
  const lot = (await listMaterialStockLots(materialId, productionId)).find(item => item.id === lotId);
  if (!lot) return Response.json({ error: "物料批次不存在" }, { status: 404 });
  if (lot.sourceType !== "rented" && lot.sourceType !== "borrowed")
    return Response.json({ error: "该批次没有对外归还义务" }, { status: 400 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim()
    || (typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "");
  if (!isMaterialSourceExceptionKind(body.kind) || typeof body.quantity !== "number"
      || !Number.isFinite(body.quantity) || body.quantity <= 0
      || idempotencyKey.length < 8 || idempotencyKey.length > 128
      || /[\p{Cc}\p{Cf}]/u.test(idempotencyKey)
      || (body.note !== undefined && typeof body.note !== "string"))
    return Response.json({ error: "来源异常参数无效" }, { status: 400 });
  try {
    const exception = await recordMaterialSourceException({
      productionId, lotId, input: { kind: body.kind, quantity: body.quantity, note: body.note },
      idempotencyKey, createdBy: session.userId,
    });
    return Response.json({ exception }, { status: 201 });
  } catch (error) {
    if (error instanceof MaterialError)
      return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
