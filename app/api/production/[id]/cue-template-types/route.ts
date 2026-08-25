import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/api-guard";
import {
  listCueTemplateTypes,
  createCueTemplateType,
  deleteCueTemplateType,
} from "@/lib/cue-template-db";

type Ctx = { params: Promise<{ id: string }> };

// Cue 模版类型注册表（#227）。类型管理归治理面：production/*/config@edit。
// 读门：config@view / config@edit / org_dept grants 读写任一（声明页共用词表）。

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, [
    ["production", "config", "view"],
    ["production", "config", "edit"],
    ["dept", "grants", "view"],
    ["dept", "grants", "edit"],
  ]);
  if (deny) return deny;
  return Response.json({ types: await listCueTemplateTypes(id) });
}

/** POST — 新建类型。Body: { key, abbrHint? } */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, [["production", "config", "edit"]], { blockArchived: true });
  if (deny) return deny;

  const body = (await req.json()) as { key?: string; abbrHint?: string };
  const key = body.key?.trim();
  if (!key) return Response.json({ error: "类型名不能为空" }, { status: 400 });
  // key 是持久标识（cue_list.template / 声明行 / URL 参数按它比较）：
  // 限长并禁掉会破坏键串解析与路由的字符
  if (key.length > 20 || /[/@*?#%\s]/.test(key)) {
    return Response.json({ error: "类型名限 20 字以内，且不含 / @ * ? # % 与空白" }, { status: 400 });
  }
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
  const { deny } = await requireGrantGate(req, id, [["production", "config", "edit"]], { blockArchived: true });
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
