import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import {
  listCueTemplateTypes,
  createCueTemplateType,
  deleteCueTemplateType,
} from "@/lib/cue-template-db";

type Ctx = { params: Promise<{ id: string }> };

// Cue 模版类型注册表（#227）。类型管理归治理面：production/*/config@edit
// （制作人显式行持有；普通基线面，非 SENSITIVE）。读=同 verb 或声明门。
async function requireGate(req: NextRequest, productionId: string, verb: "view" | "edit") {
  const session = getSession(req.cookies);
  if (!session) return { deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  const { permCtx } = access;
  const ok = session.isAdmin || permCtx.isAdmin || permCtx.isOwner ||
    await hasGrant(permCtx.userId, productionId, "production", "*", "config", "edit") ||
    (verb === "view" && await hasGrant(permCtx.userId, productionId, "org_dept", "*", "grants", "view"));
  if (!ok) return { deny: Response.json({ error: "权限不足" }, { status: 403 }) };
  if (verb === "edit" && access.isArchived) {
    return { deny: Response.json({ error: "已归档的项目不可修改" }, { status: 403 }) };
  }
  return { deny: null };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGate(req, id, "view");
  if (deny) return deny;
  return Response.json({ types: await listCueTemplateTypes(id) });
}

/** POST — 新建类型。Body: { key, abbrHint? } */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGate(req, id, "edit");
  if (deny) return deny;

  const body = (await req.json()) as { key?: string; abbrHint?: string };
  const key = body.key?.trim();
  if (!key) return Response.json({ error: "类型名不能为空" }, { status: 400 });
  try {
    const type = await createCueTemplateType(id, key, body.abbrHint?.trim().toUpperCase() || null);
    return Response.json({ type }, { status: 201 });
  } catch (e) {
    if ((e as { constraint?: string }).constraint?.includes("production_cue_template_type")) {
      return Response.json({ error: "同名类型已存在" }, { status: 409 });
    }
    throw e;
  }
}

/** DELETE — 删除类型（有存量表或声明行时拒绝）。Body: { typeId } */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGate(req, id, "edit");
  if (deny) return deny;

  const { typeId } = (await req.json()) as { typeId?: string };
  if (!typeId) return Response.json({ error: "缺少 typeId" }, { status: 400 });
  const res = await deleteCueTemplateType(id, typeId);
  if (!res.ok) {
    const msg = res.reason === "in_use" ? "仍有该类型的 Cue 表，先迁移或删除后再删类型"
      : res.reason === "has_declarations" ? "仍有该类型的声明行，先删除声明后再删类型"
      : "类型不存在";
    return Response.json({ error: msg }, { status: res.reason === "not_found" ? 404 : 409 });
  }
  return Response.json({ ok: true });
}
