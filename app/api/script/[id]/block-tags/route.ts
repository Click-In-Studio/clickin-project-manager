import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getBlockTagsForProduction, upsertBlockTag, deleteBlockTag } from "@/lib/db";
import type { ProductionAccess } from "@/lib/db";

async function guard(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, access: null as ProductionAccess | null, deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { session, access: null as ProductionAccess | null, deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  const { permCtx } = access;
  if (!(permCtx.isAdmin || await hasGrant(permCtx.userId, productionId, "script", "*", "blocks", "view"))) {
    return { session, access, deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  }
  return { session, access, deny: null };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { deny } = await guard(req, id);
  if (deny) return deny;
  const tags = await getBlockTagsForProduction(id);
  return Response.json({ tags });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const { session, access, deny } = await guard(req, productionId);
  if (!session || deny) return deny!;
  const { permCtx } = access!;
  if (!permCtx.isAdmin && !await hasGrant(permCtx.userId, productionId, "script", "*", "blocks", "edit")) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = (await req.json()) as {
    blockId?: string;
    groupId?: string;
    optionId?: string | null;
    value?: number | null;
    delete?: boolean;
  };

  const { blockId, groupId } = body;
  if (!blockId || !groupId) return Response.json({ error: "参数错误" }, { status: 400 });

  if (body.delete) {
    await deleteBlockTag(blockId, groupId);
  } else {
    const optionId = body.optionId ?? null;
    const value = body.value ?? null;
    await upsertBlockTag(blockId, groupId, optionId, value);
  }

  return Response.json({ ok: true });
}
