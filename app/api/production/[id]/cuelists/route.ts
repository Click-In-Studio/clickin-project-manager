import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext,
  getUserAllowedCueTypes,
  listCueListsWithAccess, createCueList,
} from "@/lib/db";
import { canAccessNode } from "@/lib/grant-template";
import { type PermissionContext } from "@/lib/permissions";
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
  if (!permCtx) return Response.json({ error: "无权访问" }, { status: 403 });
  // 批A：目录三态——成员可进，条目按 meta/cues view 行过滤（admin/owner 全量）
  const lists = await listCueListsWithAccess(id, session.userId, {
    seeAll: permCtx.isAdmin || permCtx.isOwner,
  });
  return Response.json(lists);
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists">) {
  const { id } = await ctx.params;
  const { session, permCtx, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!permCtx) return Response.json({ error: "无权访问" }, { status: 403 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  // 批A：集合 create 动词行（cue_list/* @ create；模板资格未激活 → 提示确认）
  const createAccess = await canAccessNode(permCtx, id, "cue_list", "*", "*", "create");
  if (!createAccess.allowed) {
    return Response.json(
      { error: createAccess.reason === "needs_self_confirm" ? "请先确认创建权限" : "权限不足" },
      { status: 403 },
    );
  }

  const body = await req.json() as { name: string; notes?: string; template?: string; abbr?: string };
  if (!body.name?.trim()) return Response.json({ error: "名称不能为空" }, { status: 400 });

  const abbr = body.abbr?.trim().toUpperCase() || null;

  if (body.template) {
    const tpl = CUE_LIST_TEMPLATES.find((t) => t.key === body.template);
    if (!tpl) return Response.json({ error: "未知模板" }, { status: 400 });
    // create_any 已并入 create：admin/owner 越过模板类型限制，其余按 dept 类型过滤
    if (!(permCtx.isAdmin || permCtx.isOwner)) {
      const allowedTypes = await getUserAllowedCueTypes(session!.userId, id);
      if (!allowedTypes.includes(body.template))
        return Response.json({ error: "无权创建该类型Cue表" }, { status: 403 });
    }
  }

  try {
    await createCueList({
      id: uid(),
      productionId: id,
      name: body.name.trim(),
      notes: body.notes?.trim() ?? "",
      abbr,
      template: body.template ?? null,
      createdBy: session!.userId,
    });
  } catch (e: unknown) {
    if ((e as { constraint?: string }).constraint === "cue_list_abbr_production_unique")
      return Response.json({ error: "简称已被同项目其他Cue表使用" }, { status: 409 });
    throw e;
  }

  const lists = await listCueListsWithAccess(id, session!.userId, {
    seeAll: permCtx.isAdmin || permCtx.isOwner,
  });
  return Response.json(lists, { status: 201 });
}
