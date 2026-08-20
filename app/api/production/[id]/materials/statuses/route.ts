import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { createMaterialStatus, deleteMaterialStatus, listMaterialStatuses } from "@/lib/material-db";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 物料状态是**列表不是状态机**（2026-08-20 用户定谳）——这里只管增删，没有流转规则。
 * 系统预设（`production_id IS NULL`）全库共用、删不掉；剧组可以加自己的。
 *
 * 门用 `material/*@edit`：能改台账的人就能维护状态表，不另设一枚键——状态表是
 * 台账的附属配置，拆开只会多一个没人会去发的键。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "material", "*", "*", "view"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  return Response.json({ statuses: await listMaterialStatuses(productionId) });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "material", "*", "*", "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as { name?: unknown; color?: unknown; orderIndex?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "状态名不能为空" }, { status: 400 });

  try {
    const status = await createMaterialStatus(
      productionId, name,
      typeof body.color === "string" ? body.color : null,
      typeof body.orderIndex === "number" ? body.orderIndex : 100,
    );
    return Response.json({ status }, { status: 201 });
  } catch (e) {
    if (e instanceof Error && e.message.includes("pms_")) 
      return Response.json({ error: "同名状态已存在" }, { status: 409 });
    throw e;
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "material", "*", "*", "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const statusId = req.nextUrl.searchParams.get("statusId");
  if (!statusId) return Response.json({ error: "缺少 statusId" }, { status: 400 });

  // 只删本剧组自定义的；系统预设由 production_id = $2 天然挡住。
  // 引用它的台账行 status_id 被 ON DELETE SET NULL 置空，不连坐删物料。
  await deleteMaterialStatus(statusId, productionId);
  return Response.json({ ok: true });
}
