import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getProductionDept } from "@/lib/dept-db";
import {
  listDeptCueTemplates,
  upsertDeptCueTemplate,
  deleteDeptCueTemplate,
  listCueTemplateTypes,
} from "@/lib/cue-template-db";

type Ctx = { params: Promise<{ id: string }> };

// Cue 表权限模版声明行（dept_cue_list_template）。声明行实例化写
// production_dept_permission，故与部门权限行同门：org_dept/*/grants@view·edit。
async function requireGate(req: NextRequest, productionId: string, verb: "view" | "edit") {
  const session = getSession(req.cookies);
  if (!session) return { deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  const { permCtx } = access;
  const ok = session.isAdmin || permCtx.isAdmin || permCtx.isOwner ||
    await hasGrant(permCtx.userId, productionId, "org_dept", "*", "grants", verb) ||
    (verb === "view" && await hasGrant(permCtx.userId, productionId, "org_dept", "*", "grants", "edit"));
  if (!ok) return { deny: Response.json({ error: "权限不足" }, { status: 403 }) };
  if (verb === "edit" && access.isArchived) {
    return { deny: Response.json({ error: "已归档的项目不可修改" }, { status: 403 }) };
  }
  return { deny: null };
}

const REL_KEY_RE = /^(?:[a-z_]+)?@(view|create|edit|delete)$/;

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGate(req, id, "view");
  if (deny) return deny;
  return Response.json({ templates: await listDeptCueTemplates(id) });
}

/** PUT — upsert 一条声明行。Body: { deptId, template, canCreate, permissions } */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGate(req, id, "edit");
  if (deny) return deny;

  const body = (await req.json()) as {
    deptId?: string; template?: string; canCreate?: boolean; permissions?: unknown;
  };
  const template = body.template?.trim();
  if (!body.deptId || !template) return Response.json({ error: "deptId 和 template 为必填" }, { status: 400 });
  if (!Array.isArray(body.permissions) || body.permissions.some(p => typeof p !== "string")) {
    return Response.json({ error: "permissions 必须为字符串数组" }, { status: 400 });
  }
  const perms = body.permissions as string[];
  for (const rel of perms) {
    if (!REL_KEY_RE.test(rel)) {
      return Response.json({ error: `非法相对键：${rel}（形如 @view 或 cues@create）` }, { status: 400 });
    }
  }
  const [dept, types] = await Promise.all([
    getProductionDept(body.deptId, id),
    listCueTemplateTypes(id),
  ]);
  if (!dept) return Response.json({ error: "部门不存在" }, { status: 404 });
  // #227 类型动态化后校验注册表，防 typo 造孤儿声明行
  if (!types.some(t => t.key === template)) {
    return Response.json({ error: `模版类型「${template}」未注册` }, { status: 400 });
  }

  await upsertDeptCueTemplate(id, body.deptId, template, !!body.canCreate, perms);
  return Response.json({ ok: true });
}

/** DELETE — 删除一条声明行。Body: { deptId, template } */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGate(req, id, "edit");
  if (deny) return deny;

  const body = (await req.json()) as { deptId?: string; template?: string };
  const template = body.template?.trim();
  if (!body.deptId || !template) return Response.json({ error: "deptId 和 template 为必填" }, { status: 400 });

  await deleteDeptCueTemplate(id, body.deptId, template);
  return Response.json({ ok: true });
}
