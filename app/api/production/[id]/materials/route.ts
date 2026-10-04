import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { canCreateMaterial } from "@/lib/ops/material-perm";
import { parseTaskSubject } from "@/lib/ops/task-poc";
import { createMaterialDefinition, getMaterialOverview, listMaterials, MaterialError } from "@/lib/ops/material-db";
import { isMaterialTrackingStrategy } from "@/lib/ops/material-types";
import { readJsonObject } from "@/lib/request-json";
import { getMaterialCapabilities } from "@/lib/ops/material-capabilities";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — 物料台账及流水派生数量。
 * 读门 `material/*@view` 在全员基线里（同 milestone / announcement 那一档的参考
 * 信息——剧组里道具在哪本来就是公开的）。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "material", "*", "*", "view"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const [materials, overview] = await Promise.all([
    listMaterials(productionId), getMaterialOverview(productionId),
  ]);
  return Response.json({
    materials, overview,
    capabilities: await getMaterialCapabilities(
      toActor(session, access.permCtx), productionId, access.isArchived, materials,
    ),
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const parsedBody = await readJsonObject(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;
  if (body.statusId !== undefined)
    return Response.json({ error: "物料状态由流转记录决定" }, { status: 400 });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "名称不能为空" }, { status: 400 });
  if (body.quantity !== undefined || body.location !== undefined)
    return Response.json({ error: "数量和库位请在确认批次时登记" }, { status: 400 });
  if (body.trackingStrategy !== undefined && !isMaterialTrackingStrategy(body.trackingStrategy))
    return Response.json({ error: "跟踪方式无效" }, { status: 400 });

  // 责任方与 task 同口径：部门 | 用户组，二选一，且必须属于本 production
  const parsed = await parseTaskSubject(productionId, body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });

  // 门在解析出责任方**之后**：能不能建取决于你要挂给谁（自己那摊可以，别人的不行）
  if (!await canCreateMaterial(toActor(session, access.permCtx), productionId, parsed.subject))
    return Response.json({ error: "权限不足" }, { status: 403 });

  try {
    const material = await createMaterialDefinition({
      productionId, name,
      category: typeof body.category === "string" ? body.category : "",
      trackingStrategy: body.trackingStrategy,
      unit: typeof body.unit === "string" ? body.unit : undefined,
      quantityScale: typeof body.quantityScale === "number" ? body.quantityScale : undefined,
      subject: parsed.subject,
      notes: typeof body.notes === "string" ? body.notes : "",
      createdBy: session.userId,
    });
    return Response.json({ material }, { status: 201 });
  } catch (e) {
    if (e instanceof MaterialError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
