import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { canCreateMaterial } from "@/lib/material-perm";
import { parseTaskSubject } from "@/lib/task-poc";
import {
  createMaterial, listMaterials, listMaterialStatuses, MaterialError,
} from "@/lib/material-db";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — 物料台账 + 可用状态列表。
 *
 * 一次返回两样：台账要渲染状态色块，分开两个请求没意义。
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

  const [materials, statuses] = await Promise.all([
    listMaterials(productionId),
    listMaterialStatuses(productionId),
  ]);
  return Response.json({ materials, statuses });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const body = (await req.json()) as {
    code?: unknown; name?: unknown; category?: unknown;
    departmentId?: unknown; groupId?: unknown; statusId?: unknown;
    location?: unknown; quantity?: unknown; notes?: unknown;
  };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!code) return Response.json({ error: "编号不能为空" }, { status: 400 });
  if (!name) return Response.json({ error: "名称不能为空" }, { status: 400 });
  if (body.quantity !== undefined && (typeof body.quantity !== "number" || body.quantity < 0))
    return Response.json({ error: "数量必须是不小于 0 的数字" }, { status: 400 });

  // 责任方与 task 同口径：部门 | 用户组，二选一，且必须属于本 production
  const parsed = await parseTaskSubject(productionId, body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });

  // 门在解析出责任方**之后**：能不能建取决于你要挂给谁（自己那摊可以，别人的不行）
  if (!await canCreateMaterial(toActor(session, access.permCtx), productionId, parsed.subject))
    return Response.json({ error: "权限不足" }, { status: 403 });

  try {
    const material = await createMaterial({
      productionId, code, name,
      category: typeof body.category === "string" ? body.category : "",
      subject: parsed.subject,
      statusId: typeof body.statusId === "string" ? body.statusId : null,
      location: typeof body.location === "string" ? body.location : "",
      quantity: typeof body.quantity === "number" ? body.quantity : 1,
      notes: typeof body.notes === "string" ? body.notes : "",
      createdBy: session.userId,
    });
    return Response.json({ material }, { status: 201 });
  } catch (e) {
    if (e instanceof MaterialError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
