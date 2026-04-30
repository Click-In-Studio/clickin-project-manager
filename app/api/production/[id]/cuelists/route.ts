import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listCueLists, createCueList } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { CUE_LIST_TEMPLATES, availableTemplatesForRoles } from "@/lib/cue-list-types";

let _seq = 0;
const uid = () => `cl${Date.now().toString(36)}${(++_seq).toString(36)}`;

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("cue:read", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "无权访问" }, { status: 403 });
  const lists = await listCueLists(id);
  return Response.json(lists);
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("cue:create", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as { name: string; notes?: string; template?: string };
  if (!body.name?.trim()) return Response.json({ error: "名称不能为空" }, { status: 400 });

  let defaultEditRoles: string[] = [];
  if (body.template) {
    const tpl = CUE_LIST_TEMPLATES.find((t) => t.key === body.template);
    if (!tpl) return Response.json({ error: "未知模板" }, { status: 400 });
    // Verify user can create this template type
    const roles = memberRoles ?? [];
    const allowed = availableTemplatesForRoles(roles, session.isAdmin);
    if (!allowed.find((t) => t.key === body.template))
      return Response.json({ error: "无权创建该类型Cue表" }, { status: 403 });
    defaultEditRoles = tpl.defaultEditRoles;
  }

  await createCueList({
    id: uid(),
    productionId: id,
    name: body.name.trim(),
    notes: body.notes?.trim() ?? "",
    template: body.template ?? null,
    defaultEditRoles,
    createdBy: session.openId,
  });

  const lists = await listCueLists(id);
  return Response.json(lists, { status: 201 });
}
