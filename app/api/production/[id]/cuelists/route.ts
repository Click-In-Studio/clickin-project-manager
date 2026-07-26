import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext,
  getUserAllowedCueTypes,
  listCueLists, createCueList, resolveRoleIdsByNames,
} from "@/lib/db";
import { hasPermission, type PermissionContext } from "@/lib/permissions";
import { CUE_LIST_TEMPLATES } from "@/lib/cue-list-types";

let _seq = 0;
const uid = () => `cl${Date.now().toString(36)}${(++_seq).toString(36)}`;

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, permCtx: null as PermissionContext | null, isArchived: false };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { session, permCtx: null as PermissionContext | null, isArchived: false };
  const { permCtx, isArchived } = access;
  return { session, permCtx, isArchived };
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists">) {
  const { id } = await ctx.params;
  const { session, permCtx } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!permCtx || !hasPermission("cue_list:view", permCtx))
    return Response.json({ error: "无权访问" }, { status: 403 });
  const lists = await listCueLists(id);
  return Response.json(lists);
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists">) {
  const { id } = await ctx.params;
  const { session, permCtx, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!permCtx) return Response.json({ error: "无权访问" }, { status: 403 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("cue_list:create", permCtx))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as { name: string; notes?: string; template?: string; abbr?: string };
  if (!body.name?.trim()) return Response.json({ error: "名称不能为空" }, { status: 400 });

  const abbr = body.abbr?.trim().toUpperCase() || null;

  let defaultRoles: string[] = [];
  if (body.template) {
    const tpl = CUE_LIST_TEMPLATES.find((t) => t.key === body.template);
    if (!tpl) return Response.json({ error: "未知模板" }, { status: 400 });
    // Admins (create_any) bypass template filtering; others must have a matching role via production_role_cue_type.
    if (!hasPermission("cue_list:create_any", permCtx)) {
      const allowedTypes = await getUserAllowedCueTypes(session!.userId, id);
      if (!allowedTypes.includes(body.template))
        return Response.json({ error: "无权创建该类型Cue表" }, { status: 403 });
    }
    defaultRoles = tpl.defaultRoles;
  }

  const roleIds = await resolveRoleIdsByNames(id, defaultRoles);

  try {
    await createCueList({
      id: uid(),
      productionId: id,
      name: body.name.trim(),
      notes: body.notes?.trim() ?? "",
      abbr,
      template: body.template ?? null,
      roleIds,
      createdBy: session!.userId,
    });
  } catch (e: unknown) {
    if ((e as { constraint?: string }).constraint === "cue_list_abbr_production_unique")
      return Response.json({ error: "简称已被同项目其他Cue表使用" }, { status: 409 });
    throw e;
  }

  const lists = await listCueLists(id);
  return Response.json(lists, { status: 201 });
}
